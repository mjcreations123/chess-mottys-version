import { Chess } from '../js/vendor/chess.js';
import { planStrategicBlackHole, HOLE_STRATEGY_LEVELS } from '../js/core/hole-strategy.js';
import { assert, ok, summary } from './helpers.mjs';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const QUICK = { strategy: { replyDepth: 2, replyTimeMs: 45 } };

{
  for (const level of ['easy', 'medium', 'hard']) {
    const first = planStrategicBlackHole(START, 'b', level, `deterministic-${level}`, QUICK);
    const second = planStrategicBlackHole(START, 'b', level, `deterministic-${level}`, QUICK);
    assert(first.square === second.square && first.selectionRank === second.selectionRank,
      `${level} trap strategy changed with the same seed`);
    assert(!new Chess(START).get(first.square), `${level} selected occupied square ${first.square}`);
    assert(first.candidates.length === 32, `${level} did not rank every opening empty square`);
  }
  ok('every level makes a deterministic strategic choice on an empty square');
}

{
  const tactical = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
  const expert = planStrategicBlackHole(tactical, 'b', 'hard', 'mate-trap', {
    strategy: { replyDepth: 4, replyTimeMs: 300 },
  });
  assert(expert.square === 'a8', `expert did not trap the forced mating destination, chose ${expert.square}`);
  assert(expert.candidates[0].score > expert.candidates[1].score, 'expert choice was not the top strategic score');
  ok('expert targets the destination of the opponent\'s forced best move');
}

// Trap quality is measured by the VALUE of the square chosen, not by its
// position in the ranking. Rank is the wrong yardstick: when the best two
// squares score identically, taking the second one costs nothing, and a test
// that demanded rank 0 was the reason Expert was perfectly predictable.
{
  // Several positions, because a single one cannot separate the levels: at the
  // start the two best squares score identically, so Club and Expert both keep
  // 100% of the available value and tie.
  const BOARDS = [
    START,
    'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1',
    'r2q1rk1/pp2bppp/2n1bn2/2pp4/3P4/2P1PN2/PPBN1PPP/R1BQ1RK1 w - - 0 1',
    '8/5ppp/8/3k4/8/4K3/5PPP/3R4 w - - 0 1',
  ];
  const retained = {};
  for (const level of ['easy', 'medium', 'hard']) {
    let total = 0;
    let plans = 0;
    const samples = 16;
    for (const board of BOARDS) {
      for (let i = 0; i < samples; i++) {
        const plan = planStrategicBlackHole(board, 'b', level, `quality-${i}`, {
          strategy: { replyDepth: 1, replyTimeMs: 25 },
        });
        const best = Math.max(...plan.candidates.map((entry) => entry.score));
        const chosen = plan.candidates.find((entry) => entry.square === plan.square).score;
        total += best > 0 ? chosen / best : 1;
        plans++;
        const floor = HOLE_STRATEGY_LEVELS[level].spreadMargin;
        assert(best <= 0 || chosen / best >= floor - 1e-9,
          `${level} chose ${plan.square} at ${(chosen / best * 100).toFixed(0)}% of the best square, below its ${floor * 100}% margin`);
      }
    }
    retained[level] = total / plans;
  }
  console.log(`  trap value kept: casual ${(retained.easy * 100).toFixed(0)}%, club ${(retained.medium * 100).toFixed(0)}%, expert ${(retained.hard * 100).toFixed(0)}%`);
  assert(retained.hard > retained.medium && retained.medium > retained.easy,
    `trap quality did not scale with difficulty: ${JSON.stringify(retained)}`);
  ok('trap-selection precision rises from Casual to Club to Expert');
}

// Regression: Expert's opening trap was c3 in twelve games out of twelve,
// because reply likelihood decayed by the move's index in the search's list
// rather than by its score. The top five opening replies all score the same, so
// the ordering being trusted was an artifact of move generation. A trap the
// opponent can memorise after one game is not hidden, which is the whole
// mechanic. The opening is the one position that is identical every single
// game, so it is the only place where concentration is genuinely exploitable.
{
  for (const level of ['medium', 'hard']) {
    const counts = new Map();
    const samples = 60;
    for (let i = 0; i < samples; i++) {
      const square = planStrategicBlackHole(START, 'b', level, `opening-${i}#bot-hole#b#1#0`, {
        strategy: { replyDepth: 2, replyTimeMs: 40 },
      }).square;
      counts.set(square, (counts.get(square) || 0) + 1);
    }
    const [square, hits] = [...counts].sort((a, b) => b[1] - a[1])[0];
    const share = hits / samples;
    console.log(`  ${level} opening trap: ${counts.size} distinct squares, most common ${square} at ${(share * 100).toFixed(0)}%`);
    assert(counts.size > 1, `${level} always opens with the same trap on ${square}: it is memorisable`);
    assert(share <= 0.75, `${level} opens on ${square} in ${(share * 100).toFixed(0)}% of games, predictable enough to play around`);
  }
  ok('the opening trap cannot be memorised from one game');
}

{
  const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
  const plan = planStrategicBlackHole(fen, 'w', 'hard', 'joint-plan');
  assert(plan.plannedMove?.from === 'a1' && plan.plannedMove?.to === 'a8',
    `joint trap plan did not preserve Expert's mating move: ${JSON.stringify(plan.plannedMove)}`);
  ok('when MottyBot moves next, trap placement carries its difficulty-level move plan forward');
}

{
  const baseline = planStrategicBlackHole(START, 'b', 'medium', 'secret-boundary', QUICK);
  const attemptedLeak = planStrategicBlackHole(START, 'b', 'medium', 'secret-boundary', {
    ...QUICK,
    playerHole: 'c3',
  });
  assert(baseline.square === attemptedLeak.square
    && JSON.stringify(baseline.candidates) === JSON.stringify(attemptedLeak.candidates),
  'an opponent secret influenced the strategic analysis');
  ok('trap analysis has no input path for the player\'s hidden square');
}


// Regression: MottyBot hunts material, not the king. The king's trap value sat
// at 12000, twelve times a queen, so a merely POSSIBLE king landing outscored a
// near-certain capture. Expert stopped playing chess and started sniping the
// king, winning games on a blind guess. This exact position used to be trapped
// on f1, a square only the king can reach.
{
  const fen = '5rk1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
  const plan = planStrategicBlackHole(fen, 'b', 'hard', 'king-hunt-guard', {
    strategy: { replyDepth: 4, replyTimeMs: 220 },
  });
  const movers = new Chess(fen).moves({ verbose: true }).filter((move) => move.to === plan.square);
  assert(movers.length > 0, `nothing can reach the trapped square ${plan.square}`);
  assert(movers.some((move) => move.piece !== 'k'),
    `expert trapped ${plan.square}, a square only the king can reach: it is hunting the king again`);
  ok('expert traps material rather than sniping the king');
}

// The engine's own eligibility filter would reject a first-pick candidate
// beside a king or in front of the opponent's pawns, falling back to a
// random square. The strategist needs to already know about both blind
// spots itself, so its top choice never gets discarded by that safety net.
{
  const plan = planStrategicBlackHole(START, 'b', 'hard', 'first-pick-guard', {
    strategy: { replyDepth: 2, replyTimeMs: 40 },
    firstPick: true,
  });
  // Black's opponent is White, so it is White's third rank (c3/f3 and
  // neighbors) that is off limits here, not Black's own.
  const forbidden = ['a3', 'b3', 'c3', 'd3', 'e3', 'f3', 'g3', 'h3', 'd8', 'd7', 'e7', 'f8', 'f7', 'd1', 'd2', 'e2', 'f1', 'f2'];
  for (const square of forbidden) {
    assert(!plan.candidates.some((entry) => entry.square === square),
      `firstPick candidates included ${square}, which the engine would reject as a first pick`);
  }
  ok('the strategist itself avoids the first-pick blind spots, not just the engine\'s fallback filter');
}

// A trap now catches its own owner too, so a square MottyBot is about to
// move its own piece onto is a guaranteed, avoidable self-goal the moment it
// re-arms there. It must never be a candidate.
{
  const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
  const plan = planStrategicBlackHole(fen, 'w', 'hard', 'self-goal-guard');
  assert(plan.plannedMove?.to === 'a8', `fixture drifted, expected the mating move to land on a8: ${JSON.stringify(plan.plannedMove)}`);
  assert(!plan.candidates.some((entry) => entry.square === 'a8'),
    'MottyBot considered trapping the exact square its own planned move is about to land on');
  ok('MottyBot never plants its trap where its own planned move is about to land');
}

summary('hole-strategy.test.mjs');
