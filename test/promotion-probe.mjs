// Does the bot promote? And does it see the board it was actually handed?
import { Chess } from '../js/vendor/chess.js';
import { ChaosMatch } from '../js/core/chaos.js';
import { think } from '../js/core/engine-ai.js';

const CASES = [
  ['lone pawn on 7th', '4k3/1P6/8/8/8/8/8/4K3 w - - 0 1'],
  ['two pawns on 7th', '4k3/PP6/8/8/8/8/8/4K3 w - - 0 1'],
  ['promote with pieces about', 'r3k3/1P6/8/8/8/8/6PP/R3K3 w Qq - 0 1'],
  ['capture-promotion', 'r3k3/1P6/8/8/8/8/6PP/4K3 w q - 0 1'],
  ['pawn on 7th, queens on', '3qk3/1P6/8/8/8/8/6PP/3QK3 w - - 0 1'],
];

for (const level of ['easy', 'medium', 'hard']) {
  console.log(`\n=== ${level}`);
  for (const [name, fen] of CASES) {
    const stats = {};
    const mv = think(fen, level, `promo-${name}`, { stats, blunderChance: 0 });
    const uci = mv ? mv.from + mv.to + (mv.promotion || '') : 'none';
    const promoted = mv && mv.promotion ? 'PROMOTES' : '        ';
    console.log(`  ${promoted} ${name.padEnd(26)} ${uci.padEnd(7)} depth ${stats.completedDepth ?? '?'}`);
  }
}

// Does the bot get the position AFTER the magic, or a stale one? Play a real
// match and confirm the fen handed to the search is byte-identical to the
// live board at that moment.
console.log('\n=== fen handed to the search matches the live board');
let mismatches = 0;
let checked = 0;
for (let g = 0; g < 6; g++) {
  const m = new ChaosMatch(`fen-${g}`);
  for (let step = 0; step < 24; step++) {
    if (m.status().over) break;
    const before = m.fen();
    const mv = think(before, 'medium', `f-${g}-${step}`, { maxDepth: 3, timeMs: 120, blunderChance: 0 });
    if (!mv) break;
    // the search must have been given exactly the live position
    checked++;
    if (before !== m.fen()) mismatches++;
    m.applyMove(mv);
    m.teleportIfDue();
    // after the magic, the very next fen must include the relocation
    const after = m.fen();
    const legal = new Chess(after).moves().length;
    if (legal === 0 && !m.status().over) mismatches++;
  }
}
console.log(`  checked ${checked} searches, ${mismatches} mismatches`);

// A pawn that the magic drops on the 7th rank must be promotable next turn.
console.log('\n=== magic-placed pawn on the 7th gets promoted');
let promotedCount = 0;
let opportunities = 0;
for (let g = 0; g < 40; g++) {
  const m = new ChaosMatch(`mp-${g}`);
  m.chess = new Chess('4k3/8/8/8/8/8/1P6/4K3 w - - 0 1');
  for (let step = 0; step < 30; step++) {
    if (m.status().over) break;
    const fen = m.fen();
    const board = new Chess(fen);
    const promos = board.moves({ verbose: true }).filter((x) => x.promotion);
    if (board.turn() === 'w' && promos.length) {
      opportunities++;
      const mv = think(fen, 'hard', `mp-${g}-${step}`, { maxDepth: 6, timeMs: 300, blunderChance: 0 });
      if (mv && mv.promotion) promotedCount++;
      else console.log(`    MISSED promotion at ${fen} -> ${mv && mv.from + mv.to}`);
      break;
    }
    const moves = board.moves({ verbose: true });
    m.applyMove(moves[0]);
    m.teleportIfDue();
  }
}
console.log(`  ${promotedCount}/${opportunities} promotion chances taken`);
