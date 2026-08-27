// Not a test: a measuring stick for how much the search understands the
// weekly rule. It plays MottyBot-that-sees-the-rule against
// MottyBot-that-does-not and reports wins, homecomings taken, and the number
// of turns each side spent sitting on its own home square.
//
//   node test/rule-awareness-probe.mjs <games> <level> <thinkMs>
//
// 2026-08-27, 40 games at medium/80ms: 6 wins to 8 with 26 draws, which is
// even inside the noise, and 132 self-blocked turns against 1637. The rule
// awareness costs no playing strength and stops MottyBot burying its own
// graveyard.
import { Chess } from '../js/vendor/chess.js';
import { ExchangeMatch, resurrectionFen, replayMatch } from '../js/core/exchange.js';
import { chooseIndex } from '../js/core/exchange-brain.js';
import { think } from '../js/core/engine-ai.js';

const GAMES = Number(process.argv[2] || 12);
const LEVEL = process.argv[3] || 'medium';
const MS = Number(process.argv[4] || 140);
const CFG = { timeMs: MS, scoreNoise: 0, endgameBonus: 0 };

function vouchersAfter(match, action) {
  try {
    return replayMatch(match.seed, [...match.serializedActions(), action]).vouchers();
  } catch { return match.vouchers(); }
}

// One full bot turn, exactly as main.js drives it.
function takeTurn(match, level, seed, aware) {
  const vouchers = aware ? match.vouchers() : undefined;
  const mv = think(match.fen(), level, seed, { ...CFG, vouchers });
  if (!mv) return null;
  const color = match.turn();

  const alternatives = [];
  const seen = new Set();
  for (const move of match.legalMoves()) {
    const options = match.resurrectionOptions(move);
    if (!options) continue;
    for (const home of options.homes) {
      if (seen.has(home)) continue;
      seen.add(home);
      const fen = resurrectionFen(match.fen(), options.victimType, color, home);
      if (!fen) continue;
      const uci = move.from + move.to + (move.promotion || '');
      alternatives.push({
        move, home, fen,
        vouchers: aware ? vouchersAfter(match, { kind: 'resurrect', uci, home }) : undefined,
      });
    }
  }

  if (alternatives.length) {
    const preview = new Chess(match.fen());
    preview.move({ from: mv.from, to: mv.to, promotion: mv.promotion || undefined });
    const fens = [preview.fen(), ...alternatives.map((a) => a.fen)];
    const list = aware
      ? [vouchersAfter(match, { kind: 'move', uci: mv.from + mv.to + (mv.promotion || '') }),
        ...alternatives.map((a) => a.vouchers)]
      : undefined;
    const { index } = chooseIndex(fens, level, `${seed}#x`, Math.round(MS * 0.7), list);
    if (index > 0) {
      const alt = alternatives[index - 1];
      match.applyMove({ from: alt.move.from, to: alt.move.to, promotion: alt.move.promotion });
      match.takeHomecoming(alt.home);
      return 'resurrect';
    }
  }
  match.applyMove(mv);
  match.keepCapture();
  return 'move';
}

let awareWins = 0, plainWins = 0, draws = 0;
const stats = { awareReturns: 0, plainReturns: 0, awareBlocks: 0, plainBlocks: 0, plies: 0 };

// Count turns where a side held a live claim and its own piece stood on the
// only home square that claim was owed.
function countBlocks(match, color) {
  let blocked = 0;
  const enemy = color === 'w' ? 'b' : 'w';
  const enemyTypes = new Set();
  for (const row of new Chess(match.fen()).board()) {
    for (const cell of row) if (cell && cell.color === enemy) enemyTypes.add(cell.type);
  }
  const chess = new Chess(match.fen());
  for (const entry of match.vouchers()[color]) {
    if (!enemyTypes.has(entry.type)) continue;
    const open = entry.homes.some((h) => !chess.get(h));
    if (!open && entry.homes.some((h) => chess.get(h)?.color === color)) blocked++;
  }
  return blocked;
}

for (let g = 0; g < GAMES; g++) {
  const awareIsWhite = g % 2 === 0;
  const match = new ExchangeMatch(`h2h-${LEVEL}-${g}`);
  let step = 0;
  for (; step < 130; step++) {
    if (match.status().over) break;
    const aware = (match.turn() === 'w') === awareIsWhite;
    const before = match.turn();
    const kind = takeTurn(match, LEVEL, `h2h-${g}-${step}`, aware);
    if (!kind) break;
    if (kind === 'resurrect') { if (aware) stats.awareReturns++; else stats.plainReturns++; }
    const blocks = countBlocks(match, before);
    if (aware) stats.awareBlocks += blocks; else stats.plainBlocks += blocks;
  }
  stats.plies += step;
  const status = match.status();
  if (!status.over || !status.winner) draws++;
  else if ((status.winner === 'w') === awareIsWhite) awareWins++;
  else plainWins++;
  process.stdout.write(`game ${g + 1}/${GAMES}: ${status.reason || 'unfinished'} winner=${status.winner || 'none'} awareWhite=${awareIsWhite}\n`);
}

console.log(JSON.stringify({ level: LEVEL, games: GAMES, awareWins, plainWins, draws, ...stats }, null, 1));
