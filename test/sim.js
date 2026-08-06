// Headless game harness: scripted White opponents vs MottyBot, with the
// invariant battery asserted every ply. Any failure prints the seed so the
// game replays deterministically.
import { MottyGame } from '../js/engine/game.js';
import { legalMoves } from '../js/engine/movegen.js';
import {
  WHITE, K, EMPTY, F_PROMO, F_EP, P,
  mvFrom, mvTo, mvFlags, alg,
} from '../js/engine/constants.js';
import { VALUES } from '../js/engine/eval.js';
import { Search } from '../js/engine/search.js';
import { mulberry32 } from '../js/engine/rng.js';

export const FAST_BUDGETS = {
  assessMs: 60, assessDepth: 3,
  moveMs: 60, moveDepth: 3,
  verifyMs: 15, verifyDepth: 2,
  finisherMs: 80, finisherDepth: 4,
};

export const OPPONENTS = {
  random(game, moves, rng) {
    return moves[Math.floor(rng() * moves.length)];
  },
  greedy(game, moves, rng) {
    let best = [], bestVal = -1;
    for (const m of moves) {
      const target = game.board.squares[mvTo(m)];
      const val =
        mvFlags(m) & F_EP ? VALUES[P]
        : target === EMPTY ? 0
        : VALUES[target < 0 ? -target : target];
      if (val > bestVal) { bestVal = val; best = [m]; }
      else if (val === bestVal) best.push(m);
    }
    return best[Math.floor(rng() * best.length)];
  },
  strong: (() => {
    const search = new Search();
    return (game, moves, rng) => {
      const res = search.think(game.board, { msBudget: 80, maxDepth: 3 });
      // respect the caller's filter (phantom-pinned squares are off-menu)
      if (res.move && moves.includes(res.move)) return res.move;
      return moves[Math.floor(rng() * moves.length)];
    };
  })(),
};

function checkKings(board, seedInfo) {
  let wk = 0, bk = 0;
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    if (board.squares[s] === K) wk++;
    if (board.squares[s] === -K) bk++;
  }
  if (wk !== 1 || bk !== 1) {
    throw new Error(`king-count violation (w=${wk} b=${bk}) ${seedInfo}`);
  }
  if (board.squares[board.kingW] !== K) throw new Error(`kingW cache stale ${seedInfo}`);
  if (board.squares[board.kingB] !== -K) throw new Error(`kingB cache stale ${seedInfo}`);
}

export async function playGame({ seed, opponent, budgets = FAST_BUDGETS, maxMoves = 200 }) {
  const game = new MottyGame({ seed, budgets });
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const pick = OPPONENTS[opponent];
  const info = `[seed=${seed} opp=${opponent}]`;
  let bounces = 0;
  const avoidTo = new Set(); // squares the Arbiter "pinned" us away from

  while (game.status === 'playing' && game.moveNumber <= maxMoves) {
    const all = legalMoves(game.board, WHITE);
    if (all.length === 0) {
      throw new Error(`White has no moves while game playing ${info} fen=${game.board.toFEN()}`);
    }
    let moves = all.filter((m) => !avoidTo.has(mvTo(m)));
    if (moves.length === 0) moves = all;
    const m = pick(game, moves, rng);
    const input = { from: alg(mvFrom(m)), to: alg(mvTo(m)) };
    if (mvFlags(m) & F_PROMO) input.promo = 'q';
    const r = game.playerMove(input);
    if (!r.legal) {
      if (r.reason === 'king-bounce') {
        if (++bounces > 400) throw new Error(`rejection livelock ${info}`);
        continue;
      }
      if (r.reason.startsWith('phantom-pin')) {
        // a confused human plays something else for a while
        avoidTo.add(mvTo(m));
        if (++bounces > 400) throw new Error(`rejection livelock ${info}`);
        continue;
      }
      throw new Error(`sim move rejected: ${r.reason} ${info} move=${input.from}${input.to}`);
    }
    avoidTo.clear();
    checkKings(game.board, info);
    if (game.status !== 'playing') break;

    await game.botReply();
    checkKings(game.board, info);
    if (game.status === 'playing') {
      const wm = legalMoves(game.board, WHITE);
      if (wm.length === 0) {
        throw new Error(`White stalemated after bot turn ${info} fen=${game.board.toFEN()}`);
      }
    }
  }

  if (game.status !== 'white-mated') {
    throw new Error(
      `game did not end in MottyBot win: status=${game.status} move=${game.moveNumber} ${info} fen=${game.board.toFEN()}`
    );
  }
  return {
    moves: game.moveNumber,
    cheats: game.cheatsFired,
    pressure: game.referee.pressure,
  };
}
