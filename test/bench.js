// Manual benchmark: node test/bench.js
// Reports search depth and nodes reached inside the real per-move budget.
import { Board } from '../js/engine/board.js';
import { Search } from '../js/engine/search.js';

const POSITIONS = [
  ['startpos', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'],
  ['middlegame', 'r1bq1rk1/pp2ppbp/2np1np1/8/2BNP3/2N1BP2/PPPQ2PP/R3K2R w KQ - 0 9'],
  ['endgame', '8/5pk1/6p1/8/3K4/8/5PP1/8 w - - 0 1'],
  ['tactical', 'r2q1rk1/ppp2ppp/2npbn2/2b1p3/2B1P3/2PP1N2/PP1N1PPP/R1BQ1RK1 b - - 0 8'],
];

for (const budget of [300, 700]) {
  console.log(`\n=== budget ${budget}ms ===`);
  for (const [name, fen] of POSITIONS) {
    const board = Board.fromFEN(fen);
    const search = new Search();
    const t0 = performance.now();
    const res = search.think(board, { msBudget: budget });
    const ms = Math.round(performance.now() - t0);
    const knps = Math.round(res.nodes / ms);
    console.log(
      `${name.padEnd(12)} depth ${String(res.depth).padStart(2)}  ` +
      `score ${String(res.score).padStart(6)}  ` +
      `${String(res.nodes).padStart(9)} nodes  ${ms}ms  ${knps}k nps`
    );
  }
}
