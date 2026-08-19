// A release-sized difficulty gate. It measures real search depth and samples
// the deliberate move-selection behavior without running a half-hour engine
// tournament on every weekly build.
import { think, LEVELS } from '../js/core/engine-ai.js';
import { assert, ok, summary } from './helpers.mjs';

const uci = (move) => move.from + move.to + (move.promotion || '');

{
  assert(LEVELS.easy.maxDepth < LEVELS.medium.maxDepth && LEVELS.medium.maxDepth < LEVELS.hard.maxDepth,
    'configured search depth does not rise with difficulty');
  assert(LEVELS.easy.timeMs < LEVELS.medium.timeMs && LEVELS.medium.timeMs < LEVELS.hard.timeMs,
    'thinking time does not rise with difficulty');
  assert(LEVELS.easy.blunderChance > LEVELS.medium.blunderChance && LEVELS.medium.blunderChance > LEVELS.hard.blunderChance,
    'deliberate inaccuracy does not fall with difficulty');
  assert(LEVELS.hard.blunderChance === 0, 'Expert must not blunder on purpose');
  ok('difficulty settings increase search and remove deliberate mistakes');
}

// Each level must reach a clearly different depth on the same middlegame at
// its real production clock.
{
  const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const depths = {};
  for (const level of ['easy', 'medium', 'hard']) {
    const stats = {};
    think(fen, level, 'depth-probe', { stats, blunderChance: 0 });
    depths[level] = stats.completedDepth || 0;
  }
  console.log(`  depth reached: casual ${depths.easy}, club ${depths.medium}, expert ${depths.hard}`);
  assert(depths.medium > depths.easy, `Club (${depths.medium}) must search deeper than Casual (${depths.easy})`);
  assert(depths.hard > depths.medium, `Expert (${depths.hard}) must search deeper than Club (${depths.medium})`);
  assert(depths.hard >= 6, `Expert only reached depth ${depths.hard}`);
  ok(`production clocks reach distinct depths (${depths.easy} / ${depths.medium} / ${depths.hard})`);
}

// At the same shallow search horizon, the configured personalities should
// still differ: Casual often accepts a weaker candidate, Club rarely does,
// and Expert always keeps the top-scored move.
{
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const samples = 200;
  const accuracy = {};
  const variety = {};
  for (const level of ['easy', 'medium', 'hard']) {
    let topChoices = 0;
    const choices = new Set();
    for (let i = 0; i < samples; i++) {
      const stats = {};
      const move = think(fen, level, `personality-${i}`, {
        maxDepth: 2,
        timeMs: 100,
        endgameBonus: 0,
        stats,
      });
      const selected = uci(move);
      choices.add(selected);
      if (selected === uci(stats.candidates[0])) topChoices++;
    }
    accuracy[level] = topChoices;
    variety[level] = choices.size;
  }
  console.log(`  top choice: casual ${accuracy.easy}/${samples}, club ${accuracy.medium}/${samples}, expert ${accuracy.hard}/${samples}`);
  assert(accuracy.easy < accuracy.medium && accuracy.medium < accuracy.hard,
    `move precision did not rise with difficulty: ${JSON.stringify(accuracy)}`);
  assert(accuracy.hard === samples && variety.hard === 1, 'Expert varied away from the top-scored move');
  assert(variety.easy > variety.medium && variety.medium > variety.hard,
    `move variety did not narrow with difficulty: ${JSON.stringify(variety)}`);
  ok('move precision rises and intentional variance falls across all three levels');
}

{
  const move = think('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'hard', 'mate-check');
  assert(move.from === 'a1' && move.to === 'a8', `Expert missed mate in one, played ${uci(move)}`);
  ok('Expert preserves a forced mate');
}

summary('levels.test.mjs');
