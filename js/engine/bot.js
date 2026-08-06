// MottyBot's honest brain: the search plus a thin personality layer —
// seeded jitter among near-equal root moves (no robotic determinism) and
// repetition avoidance. Cheating lives elsewhere; this module plays chess.

import { Search } from './search.js';

export class HonestBot {
  constructor() {
    this.search = new Search();
  }

  // rng is REQUIRED for determinism — every caller passes the game's
  // seeded stream. avoidHashes: Set of position hashKeys to steer away
  // from (repetition risk).
  choose(board, { msBudget = 700, rng, avoidHashes = null, jitterCp = 15 } = {}) {
    const res = this.search.think(board, { msBudget, avoidHashes });
    if (!res.move || !rng) return res;
    const near = res.rootScores.filter((r) => r.score >= res.score - jitterCp);
    if (near.length > 1) {
      const chosen = near[Math.floor(rng() * near.length)];
      return { ...res, move: chosen.m, score: chosen.score };
    }
    return res;
  }
}
