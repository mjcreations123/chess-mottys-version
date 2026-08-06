// Regression: the game must NEVER freeze, even in the nastiest corner the
// review fleet found — a PAWN-delivered checkmate while the bot is deeply
// behind (the fallback wipe historically spared pawns, so the checking
// pawn survived every rescue and the turn stuck on Black forever).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MottyGame } from '../js/engine/game.js';
import { legalMoves } from '../js/engine/movegen.js';
import { WHITE, BLACK } from '../js/engine/constants.js';
import { FAST_BUDGETS } from './sim.js';

test('pawn-delivered mate in a lost position never freezes the game', async () => {
  // Black Kh8 mated by the g7 pawn (Kg6 guards it, Ra8 seals g8), with
  // Black otherwise bare — deep material deficit AND mate on the board.
  for (let seed = 1; seed <= 12; seed++) {
    const game = new MottyGame({
      seed,
      fen: 'R6k/6P1/6K1/8/3Q4/8/8/8 b - - 0 1',
      budgets: FAST_BUDGETS,
    });
    assert.equal(legalMoves(game.board, BLACK).length, 0, 'fixture: bot is mated');
    const reply = await game.botReply();
    assert.ok(reply.events.length > 0, `seed ${seed}: the bot did SOMETHING`);
    if (game.status === 'playing') {
      assert.equal(game.board.turn, WHITE, `seed ${seed}: turn returned to the player`);
      assert.ok(
        legalMoves(game.board, WHITE).length > 0,
        `seed ${seed}: the player can move — no freeze`
      );
    }
  }
});

test('deep mate threat (DOOM eval) still produces a working reply', async () => {
  // Mate threat on the horizon with the bot far behind: the DOOM sentinel
  // must not poison acceptance into freezing or no-op replies.
  const game = new MottyGame({
    seed: 7,
    fen: '6k1/8/R7/1R6/8/8/5PPP/Q5K1 b - - 0 1',
    budgets: FAST_BUDGETS,
  });
  const reply = await game.botReply();
  assert.ok(reply.events.length > 0);
  if (game.status === 'playing') {
    assert.equal(game.board.turn, WHITE);
    assert.ok(legalMoves(game.board, WHITE).length > 0);
  }
});
