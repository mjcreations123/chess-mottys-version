// Illegal-state robustness: the board and movegen must stay sane on
// positions that could never arise in honest chess — because here they do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../js/engine/board.js';
import {
  legalMoves, pseudoMoves, isAttacked, inCheck,
} from '../js/engine/movegen.js';
import { evaluate } from '../js/engine/eval.js';
import {
  P, N, R, Q, K, WHITE, BLACK, parseSquare, CASTLE_WK, CASTLE_WQ,
} from '../js/engine/constants.js';

test('three black queens: movegen and eval stay sane', () => {
  const b = Board.fromFEN('3qk3/8/8/2q2q2/8/8/8/4K3 w - - 0 1');
  assert.doesNotThrow(() => legalMoves(b, WHITE));
  assert.doesNotThrow(() => legalMoves(b, BLACK));
  assert.ok(evaluate(b) < -2000, 'three queens should read as a rout');
  const blackMoves = legalMoves(b, BLACK);
  assert.ok(blackMoves.length > 40, 'three queens generate three queens of moves');
});

test('black in check while it is White to move (ignored check state)', () => {
  // White rook pins nothing; black king sits in check that Black ignored.
  const b = Board.fromFEN('4k3/8/8/8/4R3/8/8/4K3 w - - 0 1');
  assert.ok(isAttacked(b, b.kingB, WHITE), 'black king is attacked');
  assert.ok(inCheck(b, BLACK));
  assert.doesNotThrow(() => legalMoves(b, WHITE));
  assert.doesNotThrow(() => legalMoves(b, BLACK));
});

test('kings are never removed, overwritten, converted, or captured', () => {
  const b = Board.startpos();
  assert.throws(() => b.forceRemove(b.kingW));
  assert.throws(() => b.forceRemove(b.kingB));
  assert.throws(() => b.forceSet(b.kingB, -Q));
  assert.throws(() => b.forceConvert(b.kingW, Q));
  assert.throws(() => b.forceMove(parseSquare('d1'), b.kingB));
});

test('forceMove teleports and maintains king cache', () => {
  const b = Board.startpos();
  const from = parseSquare('d8'), to = parseSquare('d4');
  const displaced = b.forceMove(from, to);
  assert.equal(displaced, 0);
  assert.equal(b.squares[to], -Q);
  assert.equal(b.squares[from], 0);
  // king teleport updates the cache
  const kFrom = b.kingB;
  b.forceMove(kFrom, parseSquare('e5'));
  assert.equal(b.kingB, parseSquare('e5'));
});

test('force ops degrade castling rights to match reality', () => {
  const b = Board.startpos();
  assert.ok(b.castling & CASTLE_WK);
  b.forceRemove(parseSquare('h1'));
  assert.equal(b.castling & CASTLE_WK, 0, 'no rook, no kingside castle');
  assert.ok(b.castling & CASTLE_WQ, 'queenside survives');
});

test('force ops rehash and clear en passant', () => {
  const b = Board.startpos();
  b.makeMove(legalMoves(b, WHITE).find((m) => (m & 0x7f) === parseSquare('e2') && ((m >> 7) & 0x7f) === parseSquare('e4')));
  assert.ok(b.epSquare >= 0, 'double push sets ep');
  b.forceSet(parseSquare('e5'), -N);
  assert.equal(b.epSquare, -1, 'mutation clears ep');
  const lo = b.hashLo, hi = b.hashHi;
  b.rehash();
  assert.equal(b.hashLo, lo);
  assert.equal(b.hashHi, hi);
});

test('spawned pieces deliver completely real checks', () => {
  const b = Board.fromFEN('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  b.forceSet(parseSquare('e5'), -R);
  assert.ok(inCheck(b, WHITE), 'a spawned rook checks like a real rook');
  const moves = legalMoves(b, WHITE);
  for (const m of moves) {
    const u = b.makeMove(m);
    assert.ok(!isAttacked(b, b.kingW, BLACK), 'every reply must address the check');
    b.unmakeMove(u);
  }
});

test('missing pieces generate nothing, board never throws', () => {
  const b = Board.fromFEN('k7/8/8/8/8/8/P7/K7 w - - 0 1');
  assert.doesNotThrow(() => pseudoMoves(b, WHITE));
  assert.doesNotThrow(() => pseudoMoves(b, BLACK));
  assert.doesNotThrow(() => evaluate(b));
  const moves = legalMoves(b, WHITE);
  assert.ok(moves.length >= 3, 'pawn push + king moves');
});

test('snapshot/restore round-trips exactly', () => {
  const b = Board.fromFEN('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const snap = b.snapshot();
  const fenBefore = b.toFEN();
  for (const m of legalMoves(b, b.turn).slice(0, 6)) b.makeMove(m);
  b.forceSet(parseSquare('d4'), -Q);
  b.restore(snap);
  assert.equal(b.toFEN(), fenBefore);
});
