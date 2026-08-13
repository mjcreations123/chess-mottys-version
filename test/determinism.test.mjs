// Same seed + same move list must reproduce the same position and the same
// teleport log, or the game is not actually deterministic.
import { ChaosMatch, replayMatch } from '../js/core/chaos.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { assert, summary } from './helpers.mjs';

for (let round = 0; round < 40; round++) {
  const seed = `det-${round}`;
  const mover = makeRng(seedFromString(`det-mover-${round}`));

  // play a live game, recording UCIs the way the client would
  const live = new ChaosMatch(seed);
  const ucis = [];
  for (let step = 0; step < 60; step++) {
    if (live.status().over) break;
    const moves = live.legalMoves();
    const mv = moves[mover.int(moves.length)];
    live.applyMove({ from: mv.from, to: mv.to, promotion: mv.promotion });
    ucis.push(mv.from + mv.to + (mv.promotion || ''));
    live.teleportIfDue();
  }

  // replay from scratch
  const replayed = replayMatch(seed, ucis);
  assert(replayed.fen() === live.fen(), `fen mismatch round ${round}\nlive:     ${live.fen()}\nreplayed: ${replayed.fen()}`);
  assert(JSON.stringify(replayed.log) === JSON.stringify(live.log), `log mismatch round ${round}`);

  // a third replay with the same inputs also matches (pure determinism)
  const again = replayMatch(seed, ucis);
  assert(again.fen() === replayed.fen(), `replay not stable round ${round}`);
}
summary('determinism.test.mjs');
