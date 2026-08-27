// The difficulty gate. Three levels have to be three different opponents, and
// the weakest one has to be beatable by someone who is not good at chess.
//
// The full proof of that lives in test/level-ladder-probe.mjs, which plays
// hundreds of real games and takes an hour. This file pins the properties that
// make those games come out right, in a few seconds, on any machine.
import { think, LEVELS, evaluateFen } from '../js/core/engine-ai.js';
import { assert, ok, summary } from './helpers.mjs';

const uci = (move) => move.from + move.to + (move.promotion || '');
const ORDER = ['easy', 'medium', 'hard'];
const rising = (field) => ORDER.every((level, i) => i === 0
  || LEVELS[level][field] > LEVELS[ORDER[i - 1]][field]);
const falling = (field) => ORDER.every((level, i) => i === 0
  || LEVELS[level][field] < LEVELS[ORDER[i - 1]][field]);

// The three axes the levels are built on. Depth alone never separated them:
// with captures resolved at every leaf even a two-ply search is tactically
// clean, which is how the old Casual came to beat a careful beginner 96 games
// in 100.
{
  assert(rising('maxDepth'), 'search depth does not rise with difficulty');
  assert(rising('timeMs'), 'thinking time does not rise with difficulty');
  assert(falling('scoreNoise'), 'the haze does not thin out as difficulty rises');
  assert(LEVELS.hard.scoreNoise === 0, 'Expert must see the position clearly');
  assert(ORDER.every((level) => LEVELS[level].probeDepth === LEVELS.hard.probeDepth),
    'the levels judge a homecoming to different depths; the rules are not a difficulty setting');
  assert(LEVELS.easy.label === 'Casual' && LEVELS.medium.label === 'Average'
    && LEVELS.hard.label === 'Expert', 'the level labels drifted');
  ok('the three levels are configured as a ladder on every axis');
}

// Depth reached in practice. Deliberately NOT a comparison of two wall clocks:
// that version of this test failed whenever the machine was busy, because a
// loaded CPU quietly turns Expert into Average. Each level gets a clock long
// enough that its own maxDepth is what stops it.
{
  const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const depths = {};
  for (const level of ORDER) {
    const stats = {};
    think(fen, level, 'depth-probe', { stats, scoreNoise: 0, timeMs: 8000 });
    depths[level] = stats.completedDepth || 0;
  }
  console.log(`  depth reached: casual ${depths.easy}, average ${depths.medium}, expert ${depths.hard}`);
  assert(depths.easy <= LEVELS.easy.maxDepth + LEVELS.easy.endgameBonus,
    `Casual searched past its ceiling: ${depths.easy}`);
  assert(depths.medium > depths.easy,
    `Average (${depths.medium}) must out-search Casual (${depths.easy})`);
  assert(depths.hard >= depths.medium,
    `Expert (${depths.hard}) must never search less far than Average (${depths.medium})`);
  assert(depths.hard >= 6, `Expert only reached depth ${depths.hard} with eight seconds`);
  ok(`each level searches to its own ceiling (${depths.easy} / ${depths.medium} / ${depths.hard})`);
}

// The haze. At a fixed horizon the levels must still pick differently: Casual
// wanders off its own best move often, Average rarely, Expert never.
{
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const samples = 200;
  const accuracy = {};
  const variety = {};
  for (const level of ORDER) {
    let topChoices = 0;
    const choices = new Set();
    for (let i = 0; i < samples; i++) {
      const stats = {};
      const move = think(fen, level, `personality-${i}`, {
        maxDepth: 2, timeMs: 100, endgameBonus: 0, stats,
      });
      const selected = uci(move);
      choices.add(selected);
      if (selected === uci(stats.candidates[0])) topChoices++;
    }
    accuracy[level] = topChoices;
    variety[level] = choices.size;
  }
  console.log(`  plays its own best move: casual ${accuracy.easy}/${samples}, average ${accuracy.medium}/${samples}, expert ${accuracy.hard}/${samples}`);
  assert(accuracy.easy < accuracy.medium && accuracy.medium < accuracy.hard,
    `move precision did not rise with difficulty: ${JSON.stringify(accuracy)}`);
  assert(accuracy.hard === samples && variety.hard === 1, 'Expert varied away from its best move');
  assert(accuracy.easy < samples * 0.6,
    `Casual played its best move ${accuracy.easy}/${samples} times, which is not a haze`);
  assert(variety.easy > variety.medium && variety.medium > variety.hard,
    `move variety did not narrow with difficulty: ${JSON.stringify(variety)}`);
  ok('the haze thins out across the three levels');
}

// The floor under Casual. Weak is the target; broken is not. However hazy its
// view, it still takes a piece that is standing there for free, and it still
// finishes a mate it can see. Without these two it stops looking like an
// opponent and starts looking like a bug.
{
  const freeQueen = '4k3/8/8/3q4/8/3R4/8/4K3 w - - 0 30';
  let grabbed = 0;
  for (let i = 0; i < 60; i++) {
    const move = think(freeQueen, 'easy', `free-queen-${i}`);
    if (move.from === 'd3' && move.to === 'd5') grabbed++;
  }
  assert(grabbed >= 57, `Casual walked past a free queen ${60 - grabbed} times in 60`);

  const mateIn1 = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
  let mated = 0;
  for (let i = 0; i < 40; i++) {
    const move = think(mateIn1, 'easy', `casual-mate-${i}`);
    if (move.from === 'a1' && move.to === 'a8') mated++;
  }
  assert(mated === 40, `Casual missed mate in one ${40 - mated} times in 40`);
  ok('Casual still takes a free queen and still finishes a mate in one');
}

// Every level understands this week's house rule completely. A weak opponent
// is weak at chess; it is never confused about what the rules let it do, and
// it never values its own graveyard at less than what it is worth.
{
  const fen = '1n2k3/8/8/8/8/8/PPP5/4K3 w - - 0 20';
  const held = { w: [{ type: 'n', homes: ['b1'] }], b: [] };
  const plain = evaluateFen(fen, held) - evaluateFen(fen, null);
  const flat = evaluateFen(fen, held, { flatEval: true }) - evaluateFen(fen, null, { flatEval: true });
  console.log(`  values a dead knight at: ${Math.round(plain)} normally, ${Math.round(flat)} on a flat evaluation`);
  assert(plain > 0, 'a live claim is worth nothing');
  assert(Math.abs(plain - flat) < 1,
    `Casual's flat evaluation changed what the house rule is worth: ${Math.round(plain)} vs ${Math.round(flat)}`);
  ok('every level values the house rule in full, whatever its skill');
}

// Casual counts material and nothing else. That is what makes it unskilled
// rather than merely random: it will not develop, will not tuck its king away,
// and will not notice a ruined pawn structure, but it still knows a rook is
// worth more than a knight.
{
  const opening = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const developed = 'rnbqkbnr/pppppppp/8/8/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3';
  const normalGap = evaluateFen(developed, null) - evaluateFen(opening, null);
  const flatGap = evaluateFen(developed, null, { flatEval: true })
    - evaluateFen(opening, null, { flatEval: true });
  assert(Math.abs(normalGap) > 20,
    `the normal evaluation cannot tell a developed position from the start: ${Math.round(normalGap)}`);
  assert(Math.abs(flatGap) < 1,
    `Casual's flat evaluation still has an opinion about development: ${Math.round(flatGap)}`);
  ok('Casual judges by material alone');
}

{
  const move = think('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'hard', 'mate-check');
  assert(move.from === 'a1' && move.to === 'a8', `Expert missed mate in one, played ${uci(move)}`);
  ok('Expert preserves a forced mate');
}

summary('levels.test.mjs');
