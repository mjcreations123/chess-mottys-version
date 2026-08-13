// Diagnostic (not part of the suite): can a won endgame actually be converted?
import { Chess } from '../js/vendor/chess.js';
import { ChaosMatch } from '../js/core/chaos.js';
import { think } from '../js/core/engine-ai.js';
import { teleportChance } from '../js/core/teleport.js';

const ENDGAMES = [
  ['K+Q vs K', '7k/8/8/8/8/8/8/3QK3 w - - 0 1'],
  ['K+R vs K', '7k/8/8/8/8/8/8/3RK3 w - - 0 1'],
];

const GAMES = Number(process.env.EG_GAMES || 6);
const PLIES = Number(process.env.EG_PLIES || 115); // past the 100-halfmove draw
const TIME = Number(process.env.EG_TIME || 300);

function convert(fen, seedTag, { fullForceAt, noTeleport = false } = {}) {
  const m = new ChaosMatch(seedTag, { fullForceAt });
  m.chess = new Chess(fen);
  for (let step = 0; step < PLIES; step++) {
    const st = m.status();
    if (st.over) return st.reason === 'checkmate' ? 'mate' : 'draw';
    const mv = think(m.fen(), 'hard', `${seedTag}-${step}`, { maxDepth: 5, timeMs: TIME, quiesce: true });
    if (!mv) return 'stuck';
    m.applyMove(mv);
    if (noTeleport) m.teleportPending = false;
    else m.teleportIfDue();
  }
  return 'unfinished';
}

console.log('chance a GIVEN piece of yours is moved, on your turn');
for (const n of [15, 8, 6, 4, 3, 2, 1]) {
  console.log(`  ${String(n).padStart(2)} pieces: before ${(100 / n).toFixed(1).padStart(5)}%   now ${(teleportChance(n) / n * 100).toFixed(1).padStart(5)}%`);
}

console.log(`\nconversion, ${GAMES} games each, ${TIME}ms/move (mate / draw / unfinished)`);
for (const [label, opts] of [
  ['no teleports (ceiling)', { noTeleport: true }],
  ['always (old rule)', { fullForceAt: 1 }],
  ['threshold 8 (chosen)', { fullForceAt: 8 }],
]) {
  const cells = [];
  for (const [name, fen] of ENDGAMES) {
    const tally = { mate: 0, draw: 0, unfinished: 0, stuck: 0 };
    for (let g = 0; g < GAMES; g++) tally[convert(fen, `${label}-${name}-${g}`, opts)]++;
    cells.push(`${name}: ${tally.mate}/${tally.draw}/${tally.unfinished + tally.stuck}`);
  }
  console.log(`  ${label.padEnd(24)} ${cells.join('   ')}`);
}
