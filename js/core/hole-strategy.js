// Difficulty-aware black-hole placement for MottyBot.
//
// This module deliberately receives no opponent black-hole square. It studies
// only the visible chess position, forecasts MottyBot's next move when needed,
// and ranks empty squares by how valuable and likely an opponent landing would
// be. Its ranked choice is used as-is; sharing the opponent's hidden square is
// legal and does not reveal either trap.

import { Chess } from '../vendor/chess.js';
import { eligibleBlackHoleSquares } from './black-hole.js';
import { think } from './engine-ai.js';
import { makeRng, seedFromString } from './rng.js';

// Catching a king ends the game outright, so it edges out a queen, but only
// just. It used to sit at 12000, which made a merely POSSIBLE king landing
// outscore a near-certain queen landing by twelve to one: MottyBot stopped
// hunting material and started sniping the king, and won games by a blind
// guess rather than by chess. Traps chase material now; a king is a bonus.
const KING_TRAP_VALUE = 1100;
const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 950, k: KING_TRAP_VALUE };

// choicePool caps how many squares are ever considered. spreadMargin then
// throws out anything scoring below that fraction of the leader, so the pool is
// defined by VALUE and collapses to one square whenever one square genuinely
// dominates. sharpness biases the draw inside the surviving pool: above 1 it
// leans hard on the leader, below 1 it spreads out.
export const HOLE_STRATEGY_LEVELS = {
  easy: {
    replyDepth: 1,
    replyTimeMs: 55,
    replyTemperature: 5.8,
    choicePool: 8,
    spreadMargin: 0.10,
    sharpness: 0.35,
  },
  medium: {
    replyDepth: 3,
    replyTimeMs: 190,
    replyTemperature: 3.1,
    choicePool: 4,
    spreadMargin: 0.40,
    sharpness: 1.0,
  },
  hard: {
    replyDepth: 5,
    replyTimeMs: 520,
    replyTemperature: 1.7,
    choicePool: 4,
    spreadMargin: 0.55,
    sharpness: 1.6,
  },
};

const otherColor = (color) => color === 'w' ? 'b' : 'w';
const uci = (move) => move.from + move.to + (move.promotion || '');

function squareShape(square) {
  const file = square.charCodeAt(0) - 97;
  const rank = square.charCodeAt(1) - 49;
  const centerDistance = Math.abs(file - 3.5) + Math.abs(rank - 3.5);
  return 18 - centerDistance * 2;
}

// Draw a trap square from the squares that are genuinely close to the best one.
//
// Expert used to take the top-ranked square outright. That sounds like the
// strongest possible play and was in fact the weakest thing it could do: with
// no randomness left anywhere, its opening trap was c3 in twelve games out of
// twelve, and a hidden trap you can memorise after one game is not hidden. The
// entire value of the mechanic is that the opponent does not know.
//
// So the pool is a value judgement rather than a fixed count. Squares scoring
// within spreadMargin of the leader are treated as interchangeable and drawn in
// proportion to score^sharpness. Where one square really does dominate, as when
// a queen is about to land on it, everything else falls below the margin, the
// pool collapses to one and Expert plays exactly as it did before.
function chooseSquare(ranked, cfg, rng) {
  const top = ranked[0];
  if (!top) return { selected: null, selectionRank: -1, poolSize: 0 };

  const margin = Number.isFinite(cfg.spreadMargin) ? cfg.spreadMargin : 1;
  const sharpness = Number.isFinite(cfg.sharpness) ? cfg.sharpness : 1;
  const cap = Math.max(1, Math.min(cfg.choicePool || 1, ranked.length));
  const floor = top.score * margin;
  const pool = ranked.slice(0, cap).filter((entry) => entry.score >= floor);
  if (pool.length <= 1) return { selected: top, selectionRank: 0, poolSize: 1 };

  // Scores are normalised against the leader so sharpness means the same thing
  // whether the position is worth 1000 points or 40.
  const scale = top.score > 0 ? top.score : 1;
  const weights = pool.map((entry) => Math.pow(Math.max(entry.score, 0.01) / scale, sharpness));
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  let roll = rng.next() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return { selected: pool[i], selectionRank: i, poolSize: pool.length };
  }
  return { selected: pool[pool.length - 1], selectionRank: pool.length - 1, poolSize: pool.length };
}

export function planStrategicBlackHole(fen, botColor, level = 'medium', seed = 'motty-hole', options = {}) {
  if (!['w', 'b'].includes(botColor)) throw new Error(`invalid bot color ${botColor}`);
  const cfg = { ...(HOLE_STRATEGY_LEVELS[level] || HOLE_STRATEGY_LEVELS.medium), ...(options.strategy || {}) };
  const actualLevel = HOLE_STRATEGY_LEVELS[level] ? level : 'medium';
  const origin = new Chess(fen);
  const eligible = eligibleBlackHoleSquares(origin);
  if (!eligible.length) return { square: null, candidates: [], plannedMove: null, selectionRank: -1 };

  const forecast = new Chess(fen);
  let plannedMove = null;

  // When MottyBot moves next, choose that move at the selected chess
  // difficulty and use the resulting position to set a trap for the reply.
  // The caller can play this exact move, avoiding a second search or a plan
  // that the weaker levels later abandon.
  if (forecast.turn() === botColor && !forecast.isGameOver()) {
    plannedMove = think(forecast.fen(), actualLevel, `${seed}#planned-move`, options.move || {});
    if (plannedMove) forecast.move(plannedMove);
  }

  const opponent = otherColor(botColor);
  const legalReplies = forecast.turn() === opponent && !forecast.isGameOver()
    ? forecast.moves({ verbose: true })
    : [];
  const legalByUci = new Map(legalReplies.map((move) => [uci(move), move]));
  const replyStats = {};

  if (legalReplies.length) {
    think(forecast.fen(), actualLevel, `${seed}#reply-model`, {
      maxDepth: cfg.replyDepth,
      timeMs: cfg.replyTimeMs,
      blunderChance: 0,
      endgameBonus: 0,
      stats: replyStats,
    });
  }

  const root = (replyStats.candidates || [])
    .map((entry) => ({ ...entry, move: legalByUci.get(uci(entry)) }))
    .filter((entry) => entry.move && Number.isFinite(entry.score));
  const bestReplyScore = root[0]?.score ?? 0;
  const scoreBySquare = new Map(eligible.map((square) => [square, squareShape(square)]));
  const routesBySquare = new Map();
  const scoredDestinations = new Set();
  for (const move of legalReplies) {
    if (scoreBySquare.has(move.to)) routesBySquare.set(move.to, (routesBySquare.get(move.to) || 0) + 1);
  }

  // How many replies are strictly better than this one. This used to be the raw
  // index into the search's move list, which made a reply's likelihood depend on
  // where move generation happened to emit it. At the start position the top
  // five replies all score exactly 40, yet b1c3 drew a weight of 1.00 and d2d4
  // drew 0.17 purely from list order, and that artifact alone is why Expert
  // trapped c3 in twelve opening games out of twelve. Worse, in many middlegame
  // positions every top score is identical, so the ordering being leaned on was
  // pure noise from the search's internal heuristics. Ties must stay ties: the
  // score gap is the real signal, and rank now only separates moves the search
  // actually separated.
  const betterThan = new Map();
  for (const entry of root) {
    if (betterThan.has(entry.score)) continue;
    betterThan.set(entry.score, root.reduce((count, other) => count + (other.score > entry.score ? 1 : 0), 0));
  }

  for (const entry of root) {
    const move = entry.move;
    if (!scoreBySquare.has(move.to)) continue;
    const pieceType = move.promotion || move.piece;
    const material = PIECE_VALUE[pieceType] || 100;
    const rankWeight = Math.exp(-betterThan.get(entry.score) / cfg.replyTemperature);
    const scoreGap = Math.max(0, bestReplyScore - entry.score);
    const scoreWeight = Math.exp(-scoreGap / 180);
    const tacticalWeight = (move.captured ? 1.18 : 1) * (/[+#]/.test(move.san) ? 1.14 : 1);
    const likelihood = Math.max(0.035, rankWeight * scoreWeight);
    scoreBySquare.set(move.to, scoreBySquare.get(move.to) + material * likelihood * tacticalWeight);
    scoredDestinations.add(move.to);
  }

  // A shallow search can time out before every root move is scored. Keep all
  // legal destinations strategically meaningful even in that recovery case.
  for (const move of legalReplies) {
    if (!scoreBySquare.has(move.to)) continue;
    if (!scoredDestinations.has(move.to)) {
      const pieceType = move.promotion || move.piece;
      scoreBySquare.set(move.to, scoreBySquare.get(move.to) + (PIECE_VALUE[pieceType] || 100) * 0.025);
      scoredDestinations.add(move.to);
    }
  }

  const ranked = eligible
    .map((square) => ({
      square,
      score: Math.round((scoreBySquare.get(square) + (routesBySquare.get(square) || 0) * 4) * 100) / 100,
      routes: routesBySquare.get(square) || 0,
    }))
    .sort((a, b) => b.score - a.score || b.routes - a.routes || a.square.localeCompare(b.square));

  const rng = makeRng(seedFromString(`${seed}#${actualLevel}#black-hole-choice`));
  const { selected, selectionRank, poolSize } = chooseSquare(ranked, cfg, rng);
  const candidates = [selected, ...ranked.filter((item) => item.square !== selected.square)];

  return {
    square: selected.square,
    candidates,
    plannedMove,
    selectionRank,
    poolSize,
    forecastFen: forecast.fen(),
    replyDepth: replyStats.completedDepth || 0,
  };
}
