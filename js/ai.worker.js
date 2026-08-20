// MottyBot lives in a worker so thinking never freezes the board.
import { think } from './core/engine-ai.js';
import { planStrategicBlackHole } from './core/hole-strategy.js';

self.onmessage = (e) => {
  const { id, kind = 'move', fen, level, seed, botColor, firstPick } = e.data;
  try {
    if (kind === 'hole') {
      const strategy = planStrategicBlackHole(fen, botColor, level, seed, { firstPick });
      self.postMessage({ id, strategy });
      return;
    }
    const move = think(fen, level, seed);
    self.postMessage({ id, move });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
