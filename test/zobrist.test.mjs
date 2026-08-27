// The transposition table is only as trustworthy as its key. Every hazard a
// Zobrist hash has in this engine reduces to one question: does the key the
// board carries forward match the key you would compute from the position in
// front of you? If it ever does not, the search reads a score for a position
// it is not in, and the symptom is a hung piece rather than a crash.
//
// So this file does not test the table. It tests the key, exhaustively, over
// every kind of move the game can produce.
import { Chess } from '../js/vendor/chess.js';
import { FastBoard, moveFrom, moveTo, moveKind, KIND_EP, KIND_CASTLE, KIND_DOUBLE, movePromo } from '../js/core/fastboard.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { assert, ok, summary } from './helpers.mjs';

// Recompute from scratch and compare against what make() carried forward.
function keyMatchesPosition(board) {
  const lo = board.keyLo;
  const hi = board.keyHi;
  board.rehash();
  const same = board.keyLo === lo && board.keyHi === hi;
  board.keyLo = lo;
  board.keyHi = hi;
  return same;
}

{
  // A random walk through thousands of positions, checking the key after every
  // single make and again after every unmake. The seen counters prove the walk
  // actually reached the awkward move types rather than shuffling knights.
  const rng = makeRng(seedFromString('zobrist-walk'));
  const seen = { ep: 0, castle: 0, promo: 0, double: 0, capture: 0 };
  let made = 0;
  for (let game = 0; game < 40; game++) {
    const board = new FastBoard('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const trail = [];
    for (let step = 0; step < 120; step++) {
      const moves = board.legalMoves();
      if (!moves.length) break;
      const move = moves[rng.int(moves.length)];
      const kind = moveKind(move);
      if (kind === KIND_EP) seen.ep++;
      if (kind === KIND_CASTLE) seen.castle++;
      if (kind === KIND_DOUBLE) seen.double++;
      if (movePromo(move)) seen.promo++;
      if (board.squares[moveTo(move)] !== 0) seen.capture++;
      board.make(move);
      made++;
      assert(keyMatchesPosition(board),
        `the key drifted after a move of kind ${kind} at game ${game} step ${step}`);
      trail.push(move);
    }
    // and all the way back out again
    while (trail.length) {
      board.unmake();
      trail.pop();
      assert(keyMatchesPosition(board),
        `the key did not come back on unmake at game ${game}, ${trail.length} moves in`);
    }
  }
  assert(seen.capture > 100, `the walk barely captured anything: ${seen.capture}`);
  assert(seen.double > 100, `the walk barely double-pushed: ${seen.double}`);
  assert(seen.castle > 0, 'the walk never castled, so castling is untested');
  assert(seen.promo > 0, 'the walk never promoted, so promotion is untested');
  ok(`the key survives ${made} moves and their unmakes (${seen.castle} castles, ${seen.promo} promotions)`);
}

{
  // En passant on purpose. A random walk stumbles into it perhaps once in a
  // hundred thousand moves, and it is the one capture where the piece that
  // leaves the board is not on the square being moved to.
  let captures = 0;
  for (const [fen, from, to] of [
    ['rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3', 68, 85],
    ['rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3', 68, 83],
    ['rnbqkbnr/pppp1ppp/8/8/3pP3/8/PPP2PPP/RNBQKBNR b KQkq e3 0 3', 51, 36],
  ]) {
    const board = new FastBoard(fen);
    const move = board.legalMoves().find((m) => moveFrom(m) === from && moveTo(m) === to
      && moveKind(m) === KIND_EP);
    assert(move, `fixture lost the en passant capture in ${fen}`);
    const before = { lo: board.keyLo, hi: board.keyHi };
    board.make(move);
    captures++;
    assert(keyMatchesPosition(board), `the key drifted on an en passant capture in ${fen}`);
    board.unmake();
    assert(board.keyLo === before.lo && board.keyHi === before.hi,
      `the key did not come back after unmaking an en passant capture in ${fen}`);
  }
  ok(`the key survives ${captures} en passant captures and their unmakes`);
}

{
  // Castling rights are folded as a whole mask, because the clears in make()
  // are idempotent: a rook shuffling on and off a corner would double-XOR a
  // per-bit key and hand back a position it no longer has the rights for.
  const board = new FastBoard('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const start = { lo: board.keyLo, hi: board.keyHi };
  const a1 = 0, b1 = 1, a8 = 112, b8 = 113;
  const shuffle = [[a1, b1], [a8, b8], [b1, a1], [b8, a8]];
  for (let i = 0; i < shuffle.length; i++) {
    const [from, to] = shuffle[i];
    const move = board.legalMoves().find((m) => moveFrom(m) === from && moveTo(m) === to);
    assert(move, `fixture lost the rook shuffle at step ${i}`);
    board.make(move);
    assert(keyMatchesPosition(board), `the key drifted on rook shuffle ${i}`);
  }
  // Both queenside rooks have moved and come back, so the placement is identical
  // to the start but neither side may castle queenside any more.
  assert(board.keyLo !== start.lo || board.keyHi !== start.hi,
    'the rooks returned home and so did the key, so the lost castling rights vanished from the hash');
  board.rehash();
  assert(board.keyLo !== start.lo || board.keyHi !== start.hi,
    'even recomputed from scratch the key ignores the lost castling rights');
  ok('a rook shuffling off and back onto its corner never returns to the old key');
}

{
  // The same placement with different rights, and with the other side to move,
  // must hash differently. If it does not, the table hands back a score for a
  // position with moves this one does not have.
  const placement = 'r3k2r/8/8/8/8/8/8/R3K2R';
  const keys = new Map();
  for (const rights of ['KQkq', 'Kkq', 'kq', '-']) {
    for (const turn of ['w', 'b']) {
      const board = new FastBoard(`${placement} ${turn} ${rights} - 0 1`);
      const key = `${board.keyLo},${board.keyHi}`;
      assert(!keys.has(key), `${turn} ${rights} collided with ${keys.get(key)}`);
      keys.set(key, `${turn} ${rights}`);
    }
  }
  ok('castling rights and the side to move all change the key');
}

{
  // The en passant FILE is hashed, and only when there is a square at all.
  const a = new FastBoard('rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2');
  const b = new FastBoard('rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  assert(a.keyLo !== b.keyLo || a.keyHi !== b.keyHi,
    'a position with an en passant square hashes the same as one without');
  ok('the en passant square changes the key');
}

{
  // The halfmove clock is not hashed: the search never reads it, and hashing
  // it would make almost every node unique.
  const a = new FastBoard('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  const b = new FastBoard('4k3/8/8/8/8/8/8/4K3 w - - 47 30');
  assert(a.keyLo === b.keyLo && a.keyHi === b.keyHi,
    'the halfmove clock leaked into the key');
  ok('the halfmove clock stays out of the key');
}

{
  // Two different move orders reaching the same position must hash the same,
  // which is the entire point of the table.
  const one = new FastBoard('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const two = new FastBoard('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const play = (board, pairs) => {
    for (const [from, to] of pairs) {
      const move = board.legalMoves().find((m) => moveFrom(m) === from && moveTo(m) === to);
      assert(move, `fixture lost ${from}->${to}`);
      board.make(move);
    }
  };
  // Nf3, Nc6, Nc3, Nf6  versus  Nc3, Nf6, Nf3, Nc6
  const g1 = 6, f3 = 37, b8 = 113, c6 = 82, b1 = 1, c3 = 34, g8 = 118, f6 = 85;
  play(one, [[g1, f3], [b8, c6], [b1, c3], [g8, f6]]);
  play(two, [[b1, c3], [g8, f6], [g1, f3], [b8, c6]]);
  assert(one.keyLo === two.keyLo && one.keyHi === two.keyHi,
    'the same position reached two ways hashed differently, so the table can never hit');
  ok('transposing to the same position gives the same key');
}

// A sanity check that the board still plays legal chess after all of this.
{
  const rng = makeRng(seedFromString('zobrist-legality'));
  for (let game = 0; game < 12; game++) {
    const board = new FastBoard('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const referee = new Chess();
    for (let step = 0; step < 60; step++) {
      const moves = board.legalMoves();
      if (!moves.length) break;
      const move = moves[rng.int(moves.length)];
      const from = moveFrom(move);
      const to = moveTo(move);
      const name = (sq) => 'abcdefgh'[sq & 15] + ((sq >> 4) + 1);
      const promo = movePromo(move);
      const uci = { from: name(from), to: name(to) };
      if (promo) uci.promotion = 'x nbrq'[promo].trim() || 'q';
      const legal = referee.moves({ verbose: true }).some((m) => m.from === uci.from && m.to === uci.to
        && (m.promotion || undefined) === (uci.promotion || undefined));
      assert(legal, `the fast board produced ${uci.from}${uci.to} which chess.js calls illegal`);
      referee.move(uci);
      board.make(move);
    }
  }
  ok('move generation still agrees with chess.js after the hashing changes');
}

summary('zobrist.test.mjs');
