// The three levels must actually be three different opponents. Played as plain
// chess so the result measures the engine rather than the dice: the teleport
// rule is random enough to bury a skill gap over a handful of games.
import { Chess } from '../js/vendor/chess.js';
import { think, LEVELS } from '../js/core/engine-ai.js';
import { assert, ok, summary } from './helpers.mjs';

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const GAMES = Number(process.env.LEVEL_GAMES || 4);
const PLIES = 80;

// Returns the material edge for `a`, positive when `a` finished better.
function match(a, b, gameSeed, aIsWhite) {
  const board = new Chess();
  for (let step = 0; step < PLIES && !board.isGameOver(); step++) {
    const aToMove = (board.turn() === 'w') === aIsWhite;
    const mv = think(board.fen(), aToMove ? a : b, `${gameSeed}-${step}`);
    if (!mv) break;
    board.move(mv);
  }
  if (board.isCheckmate()) {
    const winnerIsWhite = board.turn() === 'b';
    return (winnerIsWhite === aIsWhite) ? 1000 : -1000;
  }
  let edge = 0;
  for (const cell of board.board().flat()) {
    if (!cell || cell.type === 'k') continue;
    edge += ((cell.color === 'w') === aIsWhite ? 1 : -1) * VALUE[cell.type];
  }
  return edge;
}

function series(strong, weak) {
  let strongPoints = 0;
  let weakPoints = 0;
  for (let g = 0; g < GAMES; g++) {
    const edge = match(strong, weak, `${strong}-${weak}-${g}`, g % 2 === 0);
    if (edge > 2) strongPoints++;
    else if (edge < -2) weakPoints++;
  }
  return { strongPoints, weakPoints };
}

for (const [strong, weak] of [['hard', 'easy'], ['medium', 'easy'], ['hard', 'medium']]) {
  const { strongPoints, weakPoints } = series(strong, weak);
  console.log(`  ${strong} vs ${weak}: ${strongPoints} - ${weakPoints} over ${GAMES} games`);
  assert(strongPoints > weakPoints,
    `${strong} did not outplay ${weak} (${strongPoints}-${weakPoints}); the levels are not distinct`);
}
ok('hard beats medium beats easy');

// Each level must reach a clearly different depth on the same middlegame.
{
  const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const depths = {};
  for (const level of ['easy', 'medium', 'hard']) {
    const stats = {};
    think(fen, level, 'depth-probe', { stats, blunderChance: 0 });
    depths[level] = stats.completedDepth || 0;
  }
  console.log(`  depth reached: easy ${depths.easy}, medium ${depths.medium}, hard ${depths.hard}`);
  assert(depths.medium > depths.easy, `medium (${depths.medium}) must search deeper than easy (${depths.easy})`);
  assert(depths.hard > depths.medium, `hard (${depths.hard}) must search deeper than medium (${depths.medium})`);
  assert(depths.hard >= 6, `hard only reached depth ${depths.hard}; that is not expert strength`);
  ok(`the levels search to genuinely different depths (${depths.easy} / ${depths.medium} / ${depths.hard})`);
}

// Hard must never throw away a forced mate for variety.
{
  assert(LEVELS.hard.blunderChance === 0, 'hard must not blunder on purpose');
  const mv = think('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'hard', 'mate-check');
  assert(mv.from === 'a1' && mv.to === 'a8', `hard missed mate in one, played ${mv.from}${mv.to}`);
  ok('hard plays the forced mate');
}

summary('levels.test.mjs');
