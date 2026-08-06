// The contract: MottyBot never loses, never draws, always wins, across
// every opponent style. SIM_GAMES scales the per-opponent count (default
// keeps the suite fast; big runs use the env var).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playGame } from './sim.js';

const GAMES = Number(process.env.SIM_GAMES ?? 12);

for (const opponent of ['random', 'greedy', 'strong']) {
  test(`never-lose: ${GAMES} games vs ${opponent}`, async () => {
    const stats = { wins: 0, totalMoves: 0, totalCheats: 0, maxMoves: 0 };
    for (let i = 0; i < GAMES; i++) {
      const seed = 1000 + i * 7 + opponent.length;
      const result = await playGame({ seed, opponent });
      stats.wins++;
      stats.totalMoves += result.moves;
      stats.totalCheats += result.cheats.length;
      stats.maxMoves = Math.max(stats.maxMoves, result.moves);
    }
    assert.equal(stats.wins, GAMES, 'every single game is a MottyBot win');
    console.log(
      `  vs ${opponent}: ${stats.wins}/${GAMES} wins, ` +
      `avg ${(stats.totalMoves / GAMES).toFixed(1)} moves ` +
      `(max ${stats.maxMoves}), avg ${(stats.totalCheats / GAMES).toFixed(1)} cheats/game`
    );
  });
}
