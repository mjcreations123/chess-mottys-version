import { Chess } from '../js/vendor/chess.js';
import { planStrategicBlackHole } from '../js/core/hole-strategy.js';
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

{
  const averageRank = {};
  for (const level of ['easy', 'medium', 'hard']) {
    let total = 0;
    const samples = 60;
    for (let i = 0; i < samples; i++) {
      const plan = planStrategicBlackHole(START, 'b', level, `quality-${i}`, {
        strategy: { replyDepth: 1, replyTimeMs: 25 },
      });
      total += plan.selectionRank;
      if (level === 'hard') assert(plan.selectionRank === 0, 'expert chose below the top-ranked trap');
      if (level === 'medium') assert(plan.selectionRank <= 2, 'club chose outside its top three traps');
      if (level === 'easy') assert(plan.selectionRank <= 7, 'casual chose outside its strategic shortlist');
    }
    averageRank[level] = total / samples;
  }
  console.log(`  trap rank average: casual ${averageRank.easy.toFixed(2)}, club ${averageRank.medium.toFixed(2)}, expert ${averageRank.hard.toFixed(2)}`);
  assert(averageRank.hard < averageRank.medium && averageRank.medium < averageRank.easy,
    `trap quality did not scale with difficulty: ${JSON.stringify(averageRank)}`);
  ok('trap-selection precision rises from Casual to Club to Expert');
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

summary('hole-strategy.test.mjs');
