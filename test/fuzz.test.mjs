// Invariant fuzz: play many random games under the house rule and assert the
// teleport engine never breaks a law, no matter what the dice do.
import { Chess } from '../js/vendor/chess.js';
import { ChaosMatch } from '../js/core/chaos.js';
import { parseFen, serializeFen } from '../js/core/fen.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { assert, materialSignature, checkersOn, findKing, summary } from './helpers.mjs';

const GAMES = Number(process.env.FUZZ_GAMES || 150);
const MAX_PLIES = 120;

let phases = 0;
let teleports = 0;
let shortPhases = 0;
let gamesEnded = { checkmate: 0, stalemate: 0, 'insufficient material': 0, 'fifty-move rule': 0, cap: 0 };

function castlingSubset(before, after) {
  const b = before === '-' ? '' : before;
  const a = after === '-' ? '' : after;
  return [...a].every((ch) => b.includes(ch));
}

for (let g = 0; g < GAMES; g++) {
  const seed = `fuzz-${g}`;
  const mover = makeRng(seedFromString(`mover-${g}`)); // move picker, separate stream
  const m = new ChaosMatch(seed);

  for (let step = 0; step < MAX_PLIES; step++) {
    const fenBefore = m.fen();
    const posBefore = parseFen(fenBefore);
    const sideToMove = m.turn();
    const other = sideToMove === 'w' ? 'b' : 'w';
    const sigBefore = materialSignature(m.chess);
    const preCheckers = checkersOn(fenBefore, sideToMove);

    const events = m.shuffleIfDue();
    phases++;
    teleports += events.length;
    if (events.length < 2) shortPhases++;

    const fenAfter = m.fen();
    const posAfter = parseFen(fenAfter);

    // material never changes in a shuffle
    assert(materialSignature(m.chess) === sigBefore, `material changed by shuffle g${g} s${step}\n${fenBefore}\n${fenAfter}`);

    // sides and clocks untouched
    assert(posAfter.turn === posBefore.turn, `turn changed by shuffle g${g} s${step}`);
    assert(posAfter.half === posBefore.half && posAfter.full === posBefore.full, `clocks changed g${g} s${step}`);

    // castling rights only ever shrink
    assert(castlingSubset(posBefore.castling, posAfter.castling), `castling grew g${g} s${step}: ${posBefore.castling} -> ${posAfter.castling}`);

    // no pawns on rank 1/8
    for (const [sq, piece] of posAfter.board) {
      if (piece.type === 'p') {
        const r = Number(sq[1]);
        assert(r >= 2 && r <= 7, `pawn on ${sq} g${g} s${step}\n${fenAfter}`);
      }
    }

    // distinct pieces, empty destinations, event squares coherent
    const destSet = new Set(events.map((e) => e.to));
    assert(destSet.size === events.length, `duplicate teleport dest g${g} s${step}`);
    for (const ev of events) {
      assert(posAfter.board.has(ev.to), `event dest empty on board g${g} s${step}`);
    }

    // the not-to-move king is NEVER in check after a shuffle
    assert(checkersOn(fenAfter, other).length === 0, `not-to-move king in check after shuffle g${g} s${step}\n${fenBefore}\n${fenAfter}`);

    // the to-move king gained no NEW checkers
    const postCheckers = checkersOn(fenAfter, sideToMove);
    for (const sq of postCheckers) {
      assert(preCheckers.includes(sq), `shuffle created check from ${sq} g${g} s${step}\n${fenBefore}\n${fenAfter}`);
    }

    // any teleported king landed strictly safe
    for (const ev of events) {
      if (ev.piece.type === 'k') {
        const kingColor = ev.piece.color;
        // king may have been the first event and still on ev.to
        const kingSq = findKing(m.chess, kingColor);
        if (kingSq === ev.to) {
          // safety was required at placement time; if it is the to-move king a
          // later teleport still cannot have added checkers (asserted above);
          // if not-to-move, zero checkers asserted above.
          if (kingColor === sideToMove) {
            assert(postCheckers.length === 0 || postCheckers.every((s) => preCheckers.includes(s)),
              `teleported king unsafe g${g} s${step}`);
          }
        }
      }
    }

    // my FEN round-trip stays exact
    assert(serializeFen(parseFen(fenAfter)) === fenAfter, `fen round-trip drift g${g} s${step}\n${fenAfter}`);

    // chess.js accepts the position
    new Chess(fenAfter);

    const st = m.status();
    if (st.over) { gamesEnded[st.reason] = (gamesEnded[st.reason] || 0) + 1; break; }

    // random legal move
    const moves = m.legalMoves();
    assert(moves.length > 0, `no legal moves but not game over g${g} s${step}\n${fenAfter}`);
    const mv = moves[mover.int(moves.length)];
    m.applyMove({ from: mv.from, to: mv.to, promotion: mv.promotion });
    if (step === MAX_PLIES - 1) gamesEnded.cap++;
  }
}

console.log(`  fuzz: ${GAMES} games, ${phases} phases, ${teleports} teleports, ${shortPhases} short phases`);
console.log(`  endings: ${JSON.stringify(gamesEnded)}`);
assert(teleports > phases * 1.5, 'teleports suspiciously rare');
summary('fuzz.test.mjs');
