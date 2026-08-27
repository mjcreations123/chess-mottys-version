// MottyBot lives in a worker so thinking never freezes the board.
import { think } from './core/engine-ai.js';
import { chooseIndex } from './core/exchange-brain.js';

self.onmessage = (e) => {
  const { id, kind = 'move', fen, fens, level, seed, probeMs, vouchers, vouchersList } = e.data;
  try {
    if (kind === 'choose') {
      const { index, scores } = chooseIndex(fens, level, seed, probeMs || 320, vouchersList);
      self.postMessage({ id, index, scores });
      return;
    }
    const move = think(fen, level, seed, { vouchers });
    self.postMessage({ id, move });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
