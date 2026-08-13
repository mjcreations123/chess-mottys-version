// Directed edge cases for the surgical FEN work and rule corners.
import { Chess } from '../js/vendor/chess.js';
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

// 5. A pinned-ish situation: teleporting a blocker away may NOT leave the
// not-to-move king capturable. Black to move; white bishop f1 aims at black
// king via e2-pawn gap... construct: white rook e1, white pawn e2 blocking,
// black king e8, black to move. Pawn e2 may not teleport away (discovered
// attack on the NOT-to-move king? No: black is to move, black king is the
// to-move king; white king is not-to-move). Rebuild properly:
// White to move. Black rook e8, black pawn... the black pawn e5 blocks e8
// rook from the white king e1. If that pawn teleports, white king (to move)
// would be in NEW check -> forbidden.
{
  const fen = '4r2k/8/8/4p3/8/8/8/4K3 w - - 0 1';
  const chess = new Chess(fen);
  const dests = validTeleportDests(chess, 'e5');
  // the pawn blocks e8-rook vs e1-king: every legal destination must keep
  // the file blocked, i.e. stay on e2..e7
  for (const d of dests) {
    assert(d[0] === 'e' && Number(d[1]) >= 2 && Number(d[1]) <= 7, `dest ${d} would expose the white king`);
  }
  // and simulated placement confirms no new check
  for (const d of dests) {
    const pos = applyTeleport(parseFen(fen), 'e5', d);
    const after = serializeFen(pos);
    assert(checkersOn(after, 'w').length === 0, `dest ${d} exposes white king`);
  }
  assert(dests.length > 0, 'pawn should still have somewhere to go (e-file squares)');
  ok('blocker teleport cannot create a new check');
}

// 6. King teleports only to strictly safe squares
{
  const fen = '7k/8/8/8/8/8/q7/K7 w - - 0 1'; // white king a1, black queen a2 gives check
  const chess = new Chess(fen);
  const dests = validTeleportDests(chess, 'a1');
  assert(dests.length > 0, 'king must have safe squares');
  for (const d of dests) {
    const pos = applyTeleport(parseFen(fen), 'a1', d);
    assert(checkersOn(serializeFen(pos), 'w').length === 0, `king dest ${d} not safe`);
  }
  ok('king teleport is strictly safe (and may resolve a real check)');
}

// 7. Checking piece may not teleport into a new checking square
{
  // black queen d8 checks nothing; white to move, black king h8, white queen a1
  const fen = '7k/8/8/8/8/8/8/Q6K b - - 0 1'; // black to move; white queen a1
  const chess = new Chess(fen);
  const dests = validTeleportDests(chess, 'a1'); // white queen teleports before black's turn
  for (const d of dests) {
    const pos = applyTeleport(parseFen(fen), 'a1', d);
    const after = serializeFen(pos);
    assert(checkersOn(after, 'b').length === 0, `white queen dest ${d} creates check on to-move black king`);
    assert(checkersOn(after, 'w').length === 0, `white queen dest ${d} exposes own king`);
  }
  ok('no teleport creates a check on the side to move');
}

// 8. Existing real check may persist through an unrelated teleport
{
  // white king e1 in check from black rook e8; white to move; pawns a2 h7 exist
  const fen = '4r2k/7p/8/8/8/8/P7/4K3 w - - 0 1';
  const chess = new Chess(fen);
  const dests = validTeleportDests(chess, 'a2'); // unrelated white pawn
  // pawn may go anywhere ranks 2-7 empty that does not block... blocking IS
  // allowed (checkers become subset). Not creating new check is the only law.
  assert(dests.length > 0, 'unrelated pawn can teleport during a real check');
  ok('real check persists through unrelated teleports');
}

// 9. Full phase on a bare-kings board: nothing crashes, kings stay legal
{
  const chess = new Chess('7k/8/8/8/8/8/8/K7 w - - 0 1');
  const rng = makeRng(12345);
  const events = runTeleportPhase(chess, rng);
  assert(checkersOn(chess.fen(), 'w').length === 0, 'white king safe');
  assert(checkersOn(chess.fen(), 'b').length === 0, 'black king safe');
  // kings never adjacent (adjacency = attacked by enemy king)
  ok(`bare kings phase ran (${events.length} teleports) and stayed legal`);
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
