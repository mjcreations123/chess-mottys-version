// The magic must be identical on every difficulty. Two things could break that:
// the rules engine reading the level (it cannot: it never imports the AI), or
// the AI sharing a random stream with the magic, so that a deeper search would
// consume draws and shift the outcome. Both are checked here for real.
import { Chess } from '../js/vendor/chess.js';
import { ChaosMatch } from '../js/core/chaos.js';
import { think } from '../js/core/engine-ai.js';
import { runTeleportPhase, validTeleportDests } from '../js/core/teleport.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { assert, ok, summary } from './helpers.mjs';

// Deterministic mover: always the first legal move, so the only thing that can
// differ between runs is the magic itself.
function playGame(seed, { thinkAt = null, plies = 40 } = {}) {
  const m = new ChaosMatch(seed);
  for (let step = 0; step < plies; step++) {
    if (m.status().over) break;
    if (thinkAt) {
      // run a real search and throw the answer away: if the AI touched the
      // magic's randomness, the teleports below would drift
      think(m.fen(), thinkAt, `noise-${seed}-${step}`, { maxDepth: 3, timeMs: 60 });
    }
    const moves = m.legalMoves();
    if (!moves.length) break;
    const mv = moves[0];
    m.applyMove({ from: mv.from, to: mv.to, promotion: mv.promotion });
    m.teleportIfDue();
  }
  return {
    fen: m.fen(),
    teleports: m.log.filter((e) => e.kind === 'teleport').map((e) => `${e.ply}:${e.from}${e.to}${e.piece.color}${e.piece.type}`),
  };
}

// 1. Identical games with and without each difficulty thinking alongside.
for (let round = 0; round < 6; round++) {
  const seed = `indep-${round}`;
  const base = playGame(seed);
  assert(base.teleports.length > 0, `round ${round} produced no teleports to compare`);
  for (const level of ['easy', 'medium', 'hard']) {
    const withBot = playGame(seed, { thinkAt: level });
    assert(withBot.fen === base.fen,
      `${level} changed the game: fen drifted\n  base ${base.fen}\n  ${level} ${withBot.fen}`);
    assert(JSON.stringify(withBot.teleports) === JSON.stringify(base.teleports),
      `${level} changed the magic sequence on round ${round}`);
  }
}
ok('the magic is byte-identical whether easy, medium, hard or no bot is thinking');

// 2. The draw itself is uniform, measured independently at each difficulty
//    while that difficulty's search runs in the same process.
{
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';
  const probe = new Chess(fen);
  const eligible = [];
  for (const row of probe.board()) {
    for (const cell of row) {
      if (cell && cell.color === 'w' && cell.type !== 'k' && validTeleportDests(probe, cell.square).length) {
        eligible.push(cell.square);
      }
    }
  }
  const TRIALS = 9000;
  for (const level of ['easy', 'medium', 'hard']) {
    const counts = new Map(eligible.map((sq) => [sq, 0]));
    for (let i = 0; i < TRIALS; i++) {
      if (i % 300 === 0) think(fen, level, `mix-${level}-${i}`, { maxDepth: 2, timeMs: 40 });
      const board = new Chess(fen);
      const [event] = runTeleportPhase(board, makeRng(seedFromString(`u-${level}-${i}`)), 'w');
      counts.set(event.from, counts.get(event.from) + 1);
    }
    const expected = TRIALS / eligible.length;
    let worst = 0;
    for (const [, n] of counts) worst = Math.max(worst, Math.abs(n - expected) / expected);
    console.log(`  ${level}: ${eligible.length} pieces, worst deviation ${(worst * 100).toFixed(1)}%`);
    assert(worst < 0.15, `${level}: piece choice deviated ${(worst * 100).toFixed(1)}%`);
  }
  ok('piece selection stays uniform at every difficulty');
}

// 3. Destinations too, at each difficulty.
{
  const fen = '4k3/8/8/8/8/8/4P3/4K3 b - - 0 1';
  const dests = validTeleportDests(new Chess(fen), 'e2');
  const TRIALS = 9000;
  for (const level of ['easy', 'medium', 'hard']) {
    const counts = new Map(dests.map((sq) => [sq, 0]));
    for (let i = 0; i < TRIALS; i++) {
      const board = new Chess(fen);
      const [event] = runTeleportPhase(board, makeRng(seedFromString(`d-${level}-${i}`)), 'w', { stopsAt: 0 });
      counts.set(event.to, counts.get(event.to) + 1);
    }
    const expected = TRIALS / dests.length;
    let worst = 0;
    for (const [, n] of counts) worst = Math.max(worst, Math.abs(n - expected) / expected);
    console.log(`  ${level}: ${dests.length} squares, worst deviation ${(worst * 100).toFixed(1)}%`);
    assert(worst < 0.2, `${level}: destination choice deviated ${(worst * 100).toFixed(1)}%`);
  }
  ok('destination selection stays uniform at every difficulty');
}

summary('level-independence.test.mjs');
