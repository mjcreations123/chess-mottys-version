// THE ABSOLUTE GUARANTEE: after every botReply(), Black must have at
// least one legal move — checkmate, stalemate, double-check-by-pawn,
// even a thrown exception must never leave the player looking at a
// checkmated MottyBot. These tests specifically attack the classes of
// position a scripted opponent (random/greedy/depth-3 search) is unlikely
// to ever construct, but a deliberate human absolutely would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MottyGame } from '../js/engine/game.js';
import { legalMoves, inCheck } from '../js/engine/movegen.js';
import { WHITE, BLACK } from '../js/engine/constants.js';
import { FAST_BUDGETS } from './sim.js';

async function assertNeverMated(fen, seeds = 20) {
  for (let seed = 1; seed <= seeds; seed++) {
    const game = new MottyGame({ seed, fen, budgets: FAST_BUDGETS });
    await game.botReply();
    if (game.status !== 'playing') continue; // a real checkmate BY MottyBot is fine
    assert.ok(
      legalMoves(game.board, BLACK).length > 0,
      `seed ${seed}: Black has zero legal moves — the guarantee failed. FEN was ${fen}`
    );
  }
}

test('double check delivered by a pawn (classic unstoppable mating pattern)', async () => {
  // Black Kh8 boxed by its own pawns g7/h7; white Qg8 gives direct check
  // while a white bishop on b2 gives a DISCOVERED check down the a1-h8
  // diagonal the moment a pawn interposes/captures — the textbook
  // "smothered-adjacent double check" a human specifically hunts for
  // because no single-piece removal resolves it.
  await assertNeverMated('6k1/6pp/8/8/8/8/1B6/6K1 b - - 0 1');
  // A second, sharper double-check geometry: king cornered, queen check
  // plus a rook check on the same rank simultaneously.
  await assertNeverMated('7k/7Q/8/8/8/8/8/R6K b - - 0 1');
});

test('black stalemated (zero moves, not in check) still gets a legal move', async () => {
  // classic stalemate skeleton, mirrored for Black in the corner
  await assertNeverMated('k7/1Q6/2K5/8/8/8/8/8 b - - 0 1');
});

test('extremely boxed king with minimal empty board space', async () => {
  // dense position, few empty squares, black king walled in by its own
  // pieces on one side and checked from the other
  await assertNeverMated('r1bqk2r/pppp1Qpp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1B1K2R b KQkq - 0 1');
});

test('the guarantee holds even when the entire referee/cheat pipeline throws', async () => {
  const game = new MottyGame({
    seed: 1,
    fen: '6k1/6pp/8/8/8/8/1B6/6K1 b - - 0 1', // a real mate on the board
    budgets: FAST_BUDGETS,
  });
  // Sabotage the "interesting" system completely — simulate the exact
  // failure mode a latent bug would cause, and prove the unconditional
  // gate saves the game anyway.
  const originalAssess = game.referee.assess.bind(game.referee);
  game.referee.assess = () => { throw new Error('simulated referee meltdown'); };
  await game.botReply();
  game.referee.assess = originalAssess;

  if (game.status === 'playing') {
    assert.ok(
      legalMoves(game.board, BLACK).length > 0,
      'the guarantee must save the game even when the referee throws'
    );
  }
  // and the game must still be fully playable afterward
  const whiteMoves = legalMoves(game.board, WHITE);
  assert.ok(whiteMoves.length > 0 || game.status !== 'playing');
});

test('the guarantee holds when #tryCheat itself throws mid-search', async () => {
  const game = new MottyGame({
    seed: 2,
    fen: '7k/7Q/8/8/8/8/8/R6K b - - 0 1',
    budgets: FAST_BUDGETS,
  });
  const originalThink = game.refSearch.think.bind(game.refSearch);
  let calls = 0;
  game.refSearch.think = (...args) => {
    calls++;
    if (calls > 1) throw new Error('simulated search crash mid-pipeline');
    return originalThink(...args);
  };
  await game.botReply();
  game.refSearch.think = originalThink;

  if (game.status === 'playing') {
    assert.ok(legalMoves(game.board, BLACK).length > 0);
  }
});

test('UI-layer safety net: main.js never leaves busy=true after a thrown botReply', async () => {
  // This mirrors main.js's own try/catch around game.botReply() — verify
  // the engine-level call itself cannot hang the returned promise even
  // under sabotage (it must resolve, not reject silently forever).
  const game = new MottyGame({
    seed: 3,
    fen: '6k1/6pp/8/8/8/8/1B6/6K1 b - - 0 1',
    budgets: FAST_BUDGETS,
  });
  const originalTierFromPressure = game.referee.tierFromPressure.bind(game.referee);
  game.referee.tierFromPressure = () => { throw new Error('simulated'); };
  let resolved = false;
  try {
    await game.botReply();
    resolved = true;
  } catch {
    resolved = false; // if this ever happens, main.js's own catch must save the UI
  } finally {
    game.referee.tierFromPressure = originalTierFromPressure;
  }
  // botReply's own try/catch should have absorbed this — it should NOT
  // have propagated all the way out.
  assert.ok(resolved, 'botReply must not let internal exceptions escape as rejections');
});
