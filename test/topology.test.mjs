import { Chess } from '../js/vendor/chess.js';
import { FastBoard, moveToUci, WHITE } from '../js/core/fastboard.js';
import { think } from '../js/core/engine-ai.js';
import { assert, ok, summary } from './helpers.mjs';

const uci = (move) => move.from + move.to + (move.promotion || '');

function compareGenerators(fen, holes) {
  const referee = new Chess(fen);
  referee.setHoles(holes);
  const expected = referee.moves({ verbose: true }).map(uci).sort();
  const fast = new FastBoard(fen, holes);
  const actual = fast.legalMoves().map((move) => uci(moveToUci(move))).sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `move generators disagree with holes ${holes.join(',')}\nfast ${actual}\nchess ${expected}`);
}

{
  const fen = '4k3/8/8/8/R6r/8/8/4K3 w - - 0 1';
  const board = new Chess(fen);
  board.setHoles(['d4']);
  const moves = board.moves({ square: 'a4', verbose: true }).map(uci);
  assert(moves.includes('a4c4') && !moves.includes('a4d4') && !moves.includes('a4h4'), 'rook crossed or landed on a collapsed square');
  ok('collapsed squares stop sliding pieces');
}

{
  const board = new Chess('4k3/8/8/8/8/8/8/1N2K3 w - - 0 1');
  board.setHoles(['b2']);
  const over = board.moves({ square: 'b1', verbose: true }).map(uci);
  assert(over.includes('b1c3') && over.includes('b1d2'), 'knight could not jump across a collapsed square');
  board.setHoles(['c3']);
  const onto = board.moves({ square: 'b1', verbose: true }).map(uci);
  assert(!onto.includes('b1c3'), 'knight landed on a collapsed square');
  ok('knights jump across gaps but cannot land in them');
}

{
  const board = new Chess();
  board.setHoles(['e3']);
  const moves = board.moves({ square: 'e2', verbose: true }).map(uci);
  assert(!moves.includes('e2e3') && !moves.includes('e2e4'), 'pawn moved into or through a collapsed square');
  ok('collapsed squares stop pawn movement');
}

{
  const fen = '4r1k1/8/8/8/8/8/8/4K3 w - - 0 1';
  const open = new Chess(fen);
  assert(open.isCheck(), 'control position should put the white king in check');
  open.setHoles(['e4']);
  assert(!open.isCheck(), 'attack ray crossed a collapsed square');
  const fast = new FastBoard(fen, ['e4']);
  assert(!fast.inCheck(WHITE), 'search board attack ray crossed a collapsed square');
  ok('a permanent gap blocks checks in both rule engines');
}

compareGenerators(
  'r3k2r/ppp2ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPP2PPP/R3K2R w KQkq - 2 8',
  ['c4', 'f4', 'd3'],
);
compareGenerators(
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  ['c3', 'e3', 'g3'],
);
ok('fast search and authoritative move generation agree on collapsed terrain');

{
  const fen = 'r3k2r/ppp2ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPP2PPP/R3K2R w KQkq - 2 8';
  const holes = ['c4', 'f4', 'd3'];
  const move = think(fen, 'medium', 'topology-ai', { holes, maxDepth: 3, timeMs: 180, blunderChance: 0 });
  const referee = new Chess(fen);
  referee.setHoles(holes);
  const legal = referee.moves({ verbose: true }).map(uci);
  assert(move && legal.includes(uci(move)), `AI returned an illegal topology move ${move && uci(move)}`);
  ok('MottyBot returns a legal move around collapsed squares');
}

summary('topology.test.mjs');
