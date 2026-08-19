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

const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 950, k: 12000 };

export const HOLE_STRATEGY_LEVELS = {
  easy: {
    replyDepth: 1,
    replyTimeMs: 55,
    replyTemperature: 5.8,
    choicePool: 8,
  },
  medium: {
    replyDepth: 3,
    replyTimeMs: 190,
    replyTemperature: 3.1,
    choicePool: 3,
  },
  hard: {
    replyDepth: 5,
    replyTimeMs: 520,
    replyTemperature: 1.7,
    choicePool: 1,
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

function chooseRank(level, poolSize, rng) {
  if (level === 'hard' || poolSize <= 1) return 0;
  const roll = rng.next();
  if (level === 'medium') {
    if (roll < 0.72) return 0;
    if (roll < 0.92) return Math.min(1, poolSize - 1);
    return Math.min(2, poolSize - 1);
  }
  // Casual is still strategic, but it is willing to back a less likely idea.
  if (roll < 0.30) return 0;
  if (roll < 0.48) return Math.min(1, poolSize - 1);
  return Math.min(2 + Math.floor(rng.next() * Math.max(1, poolSize - 2)), poolSize - 1);
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

  for (let rank = 0; rank < root.length; rank++) {
    const entry = root[rank];
    const move = entry.move;
    if (!scoreBySquare.has(move.to)) continue;
    const pieceType = move.promotion || move.piece;
    const material = PIECE_VALUE[pieceType] || 100;
    const rankWeight = Math.exp(-rank / cfg.replyTemperature);
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
  const poolSize = Math.min(cfg.choicePool, ranked.length);
  const selectionRank = chooseRank(actualLevel, poolSize, rng);
  const selected = ranked[selectionRank] || ranked[0];
  const candidates = [selected, ...ranked.filter((item) => item.square !== selected.square)];

  return {
    square: selected.square,
    candidates,
    plannedMove,
    selectionRank,
    forecastFen: forecast.fen(),
    replyDepth: replyStats.completedDepth || 0,
  };
}
