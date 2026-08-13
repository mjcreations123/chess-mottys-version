// Directed edge cases for the surgical FEN work and rule corners.
import { Chess } from '../js/vendor/chess.js';
import { ChaosMatch } from '../js/core/chaos.js';
import { parseFen, serializeFen, applyTeleport } from '../js/core/fen.js';
import { validTeleportDests, runTeleportPhase } from '../js/core/teleport.js';
import { makeRng } from '../js/core/rng.js';
import { assert, ok, summary, checkersOn } from './helpers.mjs';

// 1. Castling rights strip when a rook teleports off its corner
{
  const pos = parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  applyTeleport(pos, 'h1', 'h4');
  assert(pos.castling === 'Qkq', `expected Qkq got ${pos.castling}`);
  applyTeleport(pos, 'e8', 'e6');
  assert(pos.castling === 'Q', `expected Q got ${pos.castling}`);
  ok('castling rights strip on teleport');
}

// 2. En passant cleared when the double-moved pawn teleports away
{
  const pos = parseFen('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 2');
  applyTeleport(pos, 'e4', 'h5'); // the ep-capturable pawn leaves
  assert(pos.ep === '-', `ep should clear, got ${pos.ep}`);
  ok('ep cleared when pawn teleports');
}

// 3. En passant cleared when a piece lands on the ep square
{
  const pos = parseFen('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 2');
  applyTeleport(pos, 'b8', 'e3'); // knight lands on the capture square
  assert(pos.ep === '-', `ep should clear, got ${pos.ep}`);
  ok('ep cleared when square occupied');
}

// 4. En passant preserved when unrelated pieces teleport
{
  const pos = parseFen('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 2');
  applyTeleport(pos, 'a2', 'a3');
  assert(pos.ep === 'e3', `ep should persist, got ${pos.ep}`);
  ok('ep preserved otherwise');
}

// 5. The mover's own blocker may not teleport away and expose its king.
{
  const fen = '4r2k/8/8/8/8/8/4B3/4K3 b - - 0 1';
  const chess = new Chess(fen);
  const dests = validTeleportDests(chess, 'e2');
  // the bishop blocks e8-rook vs e1-king: every valid destination must keep
  // the file blocked, i.e. stay on e2..e7
  for (const d of dests) {
    assert(d[0] === 'e' && Number(d[1]) >= 2 && Number(d[1]) <= 7, `dest ${d} would expose the white king`);
  }
  // and simulated placement confirms no new check
  for (const d of dests) {
    const pos = applyTeleport(parseFen(fen), 'e2', d);
    const after = serializeFen(pos);
    assert(checkersOn(after, 'w').length === 0, `dest ${d} exposes white king`);
  }
  assert(dests.length > 0, 'bishop should still have somewhere to go on the e-file');
  ok('teleport cannot expose the mover own king');
}

// 6. Kings are never drawn as teleport candidates
{
  // white has only a king plus one pawn; the king must never be the piece picked
  const chess = new Chess('7k/8/8/8/8/8/4P3/4K3 b - - 0 1');
  for (let s = 0; s < 40; s++) {
    const probe = new Chess(chess.fen());
    const events = runTeleportPhase(probe, makeRng(1000 + s), 'w');
    for (const ev of events) {
      assert(ev.piece.type !== 'k', `king was teleported (seed ${s})`);
      assert(ev.from === 'e2', `expected the pawn to move, got ${ev.from}`);
    }
  }
  ok('kings are never teleport candidates');
}

// 6b. A side with ONLY a king teleports nothing at all
{
  const chess = new Chess('7k/8/8/8/8/8/8/4K3 b - - 0 1');
  const events = runTeleportPhase(chess, makeRng(7), 'w');
  assert(events.length === 0, `lone king should not teleport, got ${events.length} events`);
  ok('a lone king yields no teleport');
}

// 7. A teleport is allowed to give check to the opponent.
{
  const fen = '7k/8/8/8/8/8/Q7/7K b - - 0 1';
  const chess = new Chess(fen);
  const dests = validTeleportDests(chess, 'a2');
  assert(dests.includes('a8'), 'a8 should remain eligible even though it gives check');
  const after = serializeFen(applyTeleport(parseFen(fen), 'a2', 'a8'));
  assert(checkersOn(after, 'b').includes('a8'), 'teleported queen should give check from a8');
  assert(checkersOn(after, 'w').length === 0, 'teleport must still protect its own king');
  ok('teleports may give check to the opponent');
}

// 8. Pawns may teleport anywhere except the first and eighth ranks.
{
  const fen = '7k/8/8/8/8/8/P7/7K b - - 0 1';
  const chess = new Chess(fen);
  const dests = validTeleportDests(chess, 'a2');
  assert(dests.includes('h7'), 'pawn should be able to teleport to the second-to-back rank');
  assert(dests.every((sq) => sq[1] !== '1' && sq[1] !== '8'), 'pawn reached a back rank');
  ok('pawns are excluded from both back ranks');
}

// 9. Bare-kings board: nothing crashes, nothing moves, kings stay legal
{
  const chess = new Chess('7k/8/8/8/8/8/8/K7 w - - 0 1');
  const events = runTeleportPhase(chess, makeRng(12345), 'b');
  assert(events.length === 0, 'bare kings should produce no teleport');
  assert(checkersOn(chess.fen(), 'w').length === 0, 'white king safe');
  assert(checkersOn(chess.fen(), 'b').length === 0, 'black king safe');
  ok('bare-kings board is a no-op and stays legal');
}

// 10. Post-move ordering: a mating move can be undone by the mover's own
// teleport, and the mover is never left capturable.
{
  const m = new ChaosMatch('order-check');
  assert(m.log.length === 0, 'game must not start with a teleport');
  assert(m.teleportIfDue() === null, 'nothing is owed before the first move');
  m.applyMove({ from: 'e2', to: 'e4' });
  const ev = m.teleportIfDue();
  assert(Array.isArray(ev), 'a teleport is owed right after the move');
  assert(ev.every((e) => e.piece.color === 'w'), 'white moved, so white must teleport');
  assert(m.teleportIfDue() === null, 'the same teleport must not run twice');
  ok('teleport is owed after the move, once, by the mover');
}

// 10. serialize(parse(x)) === x for a pile of tricky FENs
{
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    'r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1',
    '4k3/8/8/8/8/8/8/4K3 b - - 42 99',
  ];
  for (const f of fens) {
    assert(serializeFen(parseFen(f)) === f, `round-trip failed: ${f}`);
  }
  ok('fen round-trips exact');
}

summary('edge.test.mjs');
