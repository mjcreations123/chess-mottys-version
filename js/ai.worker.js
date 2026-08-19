// MottyBot lives in a worker so thinking never freezes the board.
import { think } from './core/engine-ai.js';

self.onmessage = (e) => {
  const { id, fen, level, seed, holes = [] } = e.data;
  try {
    const move = think(fen, level, seed, { holes });
    self.postMessage({ id, move });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
