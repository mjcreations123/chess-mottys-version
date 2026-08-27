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
  assert(LEVELS.easy.mistakeChance > LEVELS.hard.mistakeChance
    && LEVELS.medium.mistakeChance > LEVELS.hard.mistakeChance,
    'Expert must make fewer mistakes than either weaker level');
  assert(LEVELS.hard.mistakeChance === 0, 'Expert must not make mistakes on purpose');
  assert(LEVELS.easy.quietDepth < LEVELS.medium.quietDepth, 'Casual must be the blindest to an exchange');
  assert(LEVELS.hard.quietDepth === -1, 'Expert must follow an exchange to the end');
  // Casual runs with no quiescence at all, so the PARITY of its search depth
  // decides who gets the last word in an exchange. On an even depth it stops
  // recapturing, which reads as broken rather than weak, and no current test
  // would notice.
  assert((LEVELS.easy.maxDepth + LEVELS.easy.endgameBonus) % 2 === 1
    && LEVELS.easy.maxDepth % 2 === 1,
    'Casual searches to an even depth with no quiescence, so it will stop recapturing');
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
    think(fen, level, 'depth-probe', { stats, mistakeChance: 0, timeMs: 8000 });
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

// Mistakes. At a fixed horizon the levels must still pick differently, and the
// shape matters as much as the rate: a weak level plays the move it found MOST
// of the time and goes properly wrong occasionally. A level that nudged every
// move a little would score the same here and look aimless on the board.
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
  console.log(`  distinct moves chosen:   casual ${variety.easy}, average ${variety.medium}, expert ${variety.hard}`);
  assert(accuracy.hard === samples && variety.hard === 1, 'Expert varied away from its best move');
  // The floor here is the whole point of the mistake model. A level that
  // wanders off its own best move on most turns does not look weak, it looks
  // like it is not trying, which is the complaint that produced this design.
  for (const level of ['easy', 'medium']) {
    assert(accuracy[level] > samples * 0.5,
      `${level} played its own best move only ${accuracy[level]}/${samples} times, which reads as aimless rather than weak`);
    assert(accuracy[level] < samples * 0.95,
      `${level} played its best move ${accuracy[level]}/${samples} times, so it never errs at all`);
    assert(variety[level] > 1, `${level} never varied its move`);
  }
  // Casual and Average deliberately make mistakes at a similar RATE. What
  // separates them is how far they see and how far they can follow an
  // exchange, which this fixed-horizon probe cannot measure. The real ladder
  // is proved by test/level-ladder-probe.mjs, which plays actual games.
  ok('every level plays its own best move most of the time, and Expert always');
}

// The floor under Casual. Weak is the target; broken is not. However hazy its
// view, it still takes a piece that is standing there for free, and it still
// finishes a mate it can see. Without these two it stops looking like an
// opponent and starts looking like a bug.
{
  const freeQueen = '4k3/8/8/3q4/8/3R4/8/4K3 w - - 0 30'; // undefended, one move
  let grabbed = 0;
  for (let i = 0; i < 60; i++) {
    const move = think(freeQueen, 'easy', `free-queen-${i}`);
    if (move.from === 'd3' && move.to === 'd5') grabbed++;
  }
  // Not 60 out of 60: a level that never misses free material is not a weak
  // player, it is a strong one with bad taste. Missing it now and then is the
  // mistake model working. Missing it often would be the floor breaking.
  assert(grabbed >= 52, `Casual walked past a free queen ${60 - grabbed} times in 60`);

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
  const worth = evaluateFen(fen, held) - evaluateFen(fen, null);
  console.log(`  values a dead knight with a clear home at: ${Math.round(worth)}`);
  assert(worth > 0, 'a live claim is worth nothing');
  // There is no per-level scaling left to drift, so pin that too: the only
  // thing separating the levels is chess, never their grasp of the rules.
  assert(ORDER.every((level) => LEVELS[level].claimScale === undefined),
    'a per-level claimScale came back; every level must value the house rule in full');
  ok('every level values the house rule in full, whatever its skill');
}

{
  const move = think('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'hard', 'mate-check');
  assert(move.from === 'a1' && move.to === 'a8', `Expert missed mate in one, played ${uci(move)}`);
  ok('Expert preserves a forced mate');
}

summary('levels.test.mjs');
