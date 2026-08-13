// Invariant fuzz: play many random games under the house rule and assert the
// teleport engine never breaks a law, no matter what the dice do.
// Order under test: side moves -> ONE of that side's non-king pieces teleports.
import { Chess } from '../js/vendor/chess.js';
import { ChaosMatch } from '../js/core/chaos.js';
import { parseFen, serializeFen } from '../js/core/fen.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { FULL_FORCE_AT } from '../js/core/teleport.js';
import { assert, ok, materialSignature, checkersOn, summary } from './helpers.mjs';

const GAMES = Number(process.env.FUZZ_GAMES || 150);
const MAX_PLIES = 120;

let turns = 0;
let teleports = 0;
let emptyPhases = 0;
let kingTeleports = 0;
let firstMoveHadPriorTeleport = 0;
let endingsLeftAlone = 0;
let passes = 0;
let noCandidates = 0;
let fullStrengthTurns = 0;
const gamesEnded = { checkmate: 0, stalemate: 0, 'insufficient material': 0, 'fifty-move rule': 0, cap: 0 };

function castlingSubset(before, after) {
  const b = before === '-' ? '' : before;
  const a = after === '-' ? '' : after;
  return [...a].every((ch) => b.includes(ch));
}

for (let g = 0; g < GAMES; g++) {
  const seed = `fuzz-${g}`;
  const mover = makeRng(seedFromString(`mover-${g}`)); // move picker, separate stream
  const m = new ChaosMatch(seed);

  // White's first move must not be preceded by any teleport
  if (m.log.length !== 0) firstMoveHadPriorTeleport++;

  for (let step = 0; step < MAX_PLIES; step++) {
    const st = m.status();
    if (st.over) { gamesEnded[st.reason] = (gamesEnded[st.reason] || 0) + 1; break; }

    // ---- the move (ordinary legal chess) ----
    const moverSide = m.turn();
    const moves = m.legalMoves();
    assert(moves.length > 0, `no legal moves but not game over g${g} s${step}\n${m.fen()}`);
    const mv = moves[mover.int(moves.length)];
    m.applyMove({ from: mv.from, to: mv.to, promotion: mv.promotion });

    // ---- the teleport owed by that move ----
    const fenBefore = m.fen();
    const posBefore = parseFen(fenBefore);
    const sideToMove = m.turn();              // the opponent now
    assert(sideToMove !== moverSide, 'turn did not flip after a move');
    const sigBefore = materialSignature(m.chess);
    const endedOnTheMove = m.status().over;

    const events = m.teleportIfDue();
    turns++;
    assert(events !== null, `no teleport owed after a move g${g} s${step}`);
    teleports += events.length;
    if (events.length === 0) emptyPhases++;
    assert(events.length <= 1, `more than one teleport per turn g${g} s${step}`);

    // A finished game is finished: nothing may relocate after the last move.
    if (endedOnTheMove) {
      assert(events.length === 0, `a finished game still teleported g${g} s${step}\n${fenBefore}`);
      assert(m.status().over, `the ending was undone g${g} s${step}`);
      endingsLeftAlone++;
    }

    // Every turn without a teleport must have a reason, and Fate is never
    // allowed to pass while the mover still has a full army.
    const phase = m.lastPhase;
    assert(phase, `no phase report g${g} s${step}`);
    if (events.length === 0 && !endedOnTheMove) {
      if (phase.eligible === 0) noCandidates++;
      else {
        assert(phase.passed, `empty phase with ${phase.eligible} candidates was not a pass g${g} s${step}`);
        assert(phase.eligible < FULL_FORCE_AT,
          `Fate passed with ${phase.eligible} eligible pieces; at or above ${FULL_FORCE_AT} it must always act g${g} s${step}`);
        passes++;
      }
    }
    if (!endedOnTheMove && phase.eligible >= FULL_FORCE_AT) {
      assert(events.length === 1, `a full army must always be teleported g${g} s${step} (eligible ${phase.eligible})`);
      fullStrengthTurns++;
    }

    const fenAfter = m.fen();
    const posAfter = parseFen(fenAfter);

    for (const ev of events) {
      // kings NEVER teleport
      if (ev.piece.type === 'k') kingTeleports++;
      assert(ev.piece.type !== 'k', `a king teleported g${g} s${step}`);
      // the teleported piece belongs to the player who just moved
      assert(ev.piece.color === moverSide,
        `${moverSide} moved but a ${ev.piece.color} piece teleported g${g} s${step}`);
      assert(posAfter.board.has(ev.to), `event dest empty on board g${g} s${step}`);
      assert(!posBefore.board.has(ev.to), `teleport landed on an occupied square g${g} s${step}`);
    }

    // material never changes in a teleport (they never capture)
    assert(materialSignature(m.chess) === sigBefore, `material changed by teleport g${g} s${step}\n${fenBefore}\n${fenAfter}`);

    // sides and clocks untouched
    assert(posAfter.turn === posBefore.turn, `turn changed by teleport g${g} s${step}`);
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

    // the player who just moved can never be left capturable
    assert(checkersOn(fenAfter, moverSide).length === 0,
      `mover's king attacked after their own teleport g${g} s${step}\n${fenBefore}\n${fenAfter}`);

    // FEN round-trip stays exact and chess.js accepts the position
    assert(serializeFen(parseFen(fenAfter)) === fenAfter, `fen round-trip drift g${g} s${step}\n${fenAfter}`);
    new Chess(fenAfter);

    if (step === MAX_PLIES - 1) gamesEnded.cap++;
  }
}

console.log(`  fuzz: ${GAMES} games, ${turns} turns, ${teleports} teleports, ${emptyPhases} empty phases`);
console.log(`  endings: ${JSON.stringify(gamesEnded)}`);
console.log(`  endings left alone by Fate: ${endingsLeftAlone}`);
console.log(`  skipped turns: ${passes} eased-off passes, ${noCandidates} with no candidate, ${endingsLeftAlone} finished games`);
console.log(`  full-strength turns (always teleported): ${fullStrengthTurns}`);
assert(kingTeleports === 0, 'a king teleported');
assert(firstMoveHadPriorTeleport === 0, 'a game started with a teleport before white moved');
assert(endingsLeftAlone > 0, 'no game actually ended, so mate finality was never exercised');
assert(fullStrengthTurns > 0, 'no full-strength turn was exercised');
assert(passes + noCandidates + endingsLeftAlone === turns - teleports,
  'some turn was skipped without an explanation');
assert(teleports >= turns * 0.7, 'teleports suspiciously rare across whole games');
ok(`${GAMES} random games preserved every house-rule invariant`);
summary('fuzz.test.mjs');
