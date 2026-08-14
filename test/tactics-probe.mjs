// Diagnostic: what does each level actually play, and how deep does it get?
import { think, LEVELS } from '../js/core/engine-ai.js';

const CASES = [
  ['free queen on d5', '7k/8/8/3q4/4P3/8/8/7K w - - 0 1', ['e4d5']],
  ['mate in one (Ra8#)', '7k/8/7K/8/8/8/8/R7 w - - 0 1', ['a1a8']],
  ['win the loose queen', 'rnb1kbnr/pppp1ppp/8/4p3/7q/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 1', ['f3h4']],
  ['take the hanging rook', '4k3/8/8/8/8/8/4r3/4K2R w K - 0 1', ['h1h2', 'e1e2']],
  ['do not hang the queen', '4k3/8/8/8/8/8/3QP3/4K3 w - - 0 1', null],
  ['open position develop', 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', null],
  ['mate in two', '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', ['a1a8']],
  ['win a knight fork', 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4', null],
];

for (const level of ['easy', 'medium', 'hard']) {
  console.log(`\n=== ${level}  ${JSON.stringify(LEVELS[level])}`);
  for (const [name, fen, want] of CASES) {
    const stats = {};
    const t0 = Date.now();
    const mv = think(fen, level, `probe-${name}`, { stats });
    const played = mv ? mv.from + mv.to + (mv.promotion || '') : 'none';
    const verdict = want ? (want.includes(played) ? 'OK ' : 'BAD') : '   ';
    console.log(`  ${verdict} ${name.padEnd(24)} played ${played.padEnd(6)} depth ${String(stats.depth ?? '?').padStart(2)}  ${String(stats.nodes ?? 0).padStart(8)} nodes  ${String(Date.now() - t0).padStart(5)}ms  score ${stats.score ?? '?'}`);
  }
}
