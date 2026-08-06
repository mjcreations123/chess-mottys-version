// Per-cheat fixtures: each generator produces candidates in a position
// built to trigger it, and the emergency chain escapes a checkmate that is
// already on the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../js/engine/board.js';
import { MottyGame } from '../js/engine/game.js';
import { Search } from '../js/engine/search.js';
import { legalMoves, inCheck } from '../js/engine/movegen.js';
import { WHITE, BLACK } from '../js/engine/constants.js';
import { CHEATS, generateTier } from '../js/engine/cheats/generators.js';
import { verifyCheat, applyMutations, buildFallback } from '../js/engine/cheats/verify.js';
import { FAST_BUDGETS } from './sim.js';

const search = new Search();
const genById = Object.fromEntries(CHEATS.map((c) => [c.id, c.gen]));
const ctxFor = (fen, extras = {}) => ({
  board: Board.fromFEN(fen),
  rng: () => 0.5,
  searcher: search,
  assess: { botInCheck: false },
  lastPlayerMove: null,
  lastPlayerCapture: null,
  ...extras,
});

test('LONG_PAWN generates from the home rank with three clear squares', () => {
  const ctx = ctxFor('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
  const out = genById.LONG_PAWN(ctx);
  assert.ok(out.length >= 8, 'all eight pawns volunteer');
  assert.ok(out.every((c) => c.muts.length === 1 && c.events[0].path?.length === 4));
});

test('WIDE_KNIGHT finds a (3,1) capture', () => {
  // black knight b8; white queen sits at a5 — a (3,1) leap away
  const ctx = ctxFor('rn2k3/8/8/Q7/8/8/8/4K3 b - - 0 1');
  const out = genById.WIDE_KNIGHT(ctx);
  assert.ok(out.some((c) => c.notation === 'Nxa5'));
});

test('TELEPORT: two-square hops to useful EMPTY squares only', () => {
  // d6 is two away, blocked by the d7 pawn, and eyes the white queen on d4
  const near = genById.TELEPORT(ctxFor('3qk3/2ppp3/8/8/3Q4/8/8/4K3 b - - 0 1'));
  assert.ok(near.some((c) => c.events[0].to === 'd6'), 'short blocked hop found');
  // no captures of anything bigger than a pawn, and nothing cross-board
  for (const c of near) {
    if (c.events[0].captured) {
      assert.equal(c.events[0].captured.type, 'p', 'teleports only snack on pawns');
    }
  }
  const far = genById.TELEPORT(ctxFor('3qk3/8/8/8/8/8/8/R3K3 b - - 0 1'));
  assert.ok(
    far.every((c) => !c.events[0] || c.events[0].to !== 'a1'),
    'no cross-board teleports'
  );
});

test('REGIME: normal rotation (tiers 1-2) is sneaky move-shaped cheats only', () => {
  const SNEAKY = new Set([
    'LONG_PAWN', 'WIDE_KNIGHT', 'SLIDER_PHASE', 'BISHOP_DRIFT',
    'SNEAKY_CASTLE', 'EP_ABUSE', 'ROOK_SIDESTEP', 'FORWARD_BITE',
    'DOUBLE_MOVE', 'TELEPORT',
  ]);
  for (const c of CHEATS) {
    if (c.tier <= 2 && c.weight > 0) {
      assert.ok(SNEAKY.has(c.id), `${c.id} must not be in the normal rotation`);
    }
  }
  // and the blatant families are all quarantined at tier 3
  for (const id of ['DELETE', 'SPAWN', 'RESURRECT', 'CONVERT', 'STEAL', 'MITOSIS', 'IGNORE_CHECK', 'THE_UNDO']) {
    const entry = CHEATS.find((c) => c.id === id);
    assert.equal(entry.tier, 3, `${id} is endgame/emergency only`);
  }
});

test('EP_ABUSE and FORWARD_BITE never eat majors', () => {
  // black pawn d4 beside a white ROOK e4 and under a white QUEEN d3
  const ctx = ctxFor('4k3/8/8/8/3pR3/3Q4/8/4K3 b - - 0 1');
  const ep = genById.EP_ABUSE(ctx);
  assert.ok(ep.every((c) => c.score < 500), 'no rook/queen victims via en passant');
  const bite = genById.FORWARD_BITE(ctx);
  assert.equal(bite.length, 0, 'no queen for breakfast');
});

test('DELETE targets the piece checking the black king', () => {
  const board = Board.fromFEN('4k3/8/4R3/8/8/8/8/4K3 b - - 0 1');
  const ctx = { board, rng: () => 0.5, searcher: search,
    assess: { botInCheck: true }, lastPlayerMove: null, lastPlayerCapture: null };
  const out = genById.DELETE(ctx);
  assert.equal(out[0].events[0].square, 'e6', 'the checker goes first');
});

test('IGNORE_CHECK proposes only moves that leave the check standing', () => {
  const board = Board.fromFEN('4k3/8/8/b7/8/8/4R3/4K3 b - - 0 1');
  // wait: black must be IN check — white rook e2 checks e8 through... e-file blocked? No: e2-e8 clear -> check.
  assert.ok(inCheck(board, BLACK));
  const ctx = { board, rng: () => 0.5, searcher: search,
    assess: { botInCheck: true }, lastPlayerMove: null, lastPlayerCapture: null };
  const out = genById.IGNORE_CHECK(ctx);
  for (const c of out) {
    const snap = board.snapshot();
    applyMutations(board, c.muts);
    assert.ok(inCheck(board, BLACK), `${c.notation} must leave the check unresolved`);
    board.restore(snap);
  }
});

test('SPAWN finds a royal fork square', () => {
  const ctx = ctxFor('4k3/8/8/8/8/8/3QK3/7R b - - 0 1');
  const out = genById.SPAWN(ctx);
  assert.ok(out.length > 0, 'a knight materializes somewhere profitable');
});

test('verifyCheat rejects cheats that stalemate White', () => {
  // White: Ka1 (boxed by Qb3) + Nh1, White's only mobile piece. A cheat
  // that deletes the knight would stalemate White — a draw, i.e. a loss.
  const board = Board.fromFEN('4k3/8/8/8/8/1q6/8/K6N w - - 0 1');
  const candidate = {
    id: 'DELETE', tier: 2, drama: 0, score: 0,
    muts: [{ op: 'remove', sq: 7 }],
    events: [], notation: null,
  };
  const v = verifyCheat(board, search, candidate, -10000, FAST_BUDGETS);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'white-stalemated');
});

test('emergency chain escapes a checkmate already on the board', async () => {
  // Black is mated: Ka8, white Qb7 (guarded by Qc6). MottyBot does not care.
  const game = new MottyGame({
    seed: 42,
    fen: 'k7/1Q6/2Q5/8/8/8/8/4K3 b - - 0 1',
    budgets: FAST_BUDGETS,
  });
  assert.ok(inCheck(game.board, BLACK));
  assert.equal(legalMoves(game.board, BLACK).length, 0, 'genuinely mated');
  const reply = await game.botReply();
  assert.ok(reply.events.length > 0, 'something absolutely happened');
  if (game.status === 'playing') {
    assert.ok(legalMoves(game.board, WHITE).length > 0, 'White can still move');
    const stillMated = inCheck(game.board, BLACK) && legalMoves(game.board, BLACK).length === 0;
    assert.ok(!stillMated, 'the mate has been handled, one way or another');
  }
});

test('fallback wipe always produces a verified candidate', () => {
  const board = Board.fromFEN('4k3/8/8/8/8/8/PPP5/RNBQKBNR b KQ - 0 1');
  let ok = false;
  for (const fb of buildFallback(board)) {
    const v = verifyCheat(board, search, fb, 100, FAST_BUDGETS);
    if (v.ok) { ok = true; break; }
  }
  assert.ok(ok, 'the wipe verifies somewhere on the board');
});

test('generateTier respects once-per-game exclusions', () => {
  const ctx = ctxFor('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
  const used = new Set(['THE_UNDO', 'MITOSIS', 'STEAL', 'GRAVITY']);
  const out = generateTier(ctx, 3, used);
  assert.ok(out.every((c) => !used.has(c.id)));
});
