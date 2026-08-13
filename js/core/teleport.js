// The house rule. AFTER a player makes an ordinary legal move, one uniformly
// random eligible piece of theirs teleports to one uniformly random eligible
// empty square. Kings never teleport. A non-king piece may land en prise and
// may give check. The only safety constraint is that the teleport may not
// expose the mover's own king, because the resulting position must still be a
// legal position when the opponent's turn begins.

import { Chess } from '../vendor/chess.js';
import { parseFen, serializeFen, applyTeleport, SQUARES } from './fen.js';

function findKing(chess, color) {
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === color) return cell.square;
    }
  }
  throw new Error(`no ${color} king`);
}

// All valid teleport destinations for the piece on `from`, in stable order.
export function validTeleportDests(chess, from) {
  const piece = chess.get(from);
  if (!piece || piece.type === 'k') return [];
  const opponent = piece.color === 'w' ? 'b' : 'w';

  const scratch = new Chess(chess.fen());
  const ownKing = findKing(scratch, piece.color);

  const dests = [];
  for (const to of SQUARES) {
    if (to === from || chess.get(to)) continue;
    if (piece.type === 'p') {
      const r = to.charCodeAt(1) - 48;
      if (r === 1 || r === 8) continue;
    }

    scratch.remove(from);
    const placed = scratch.put({ type: piece.type, color: piece.color }, to);
    if (!placed) { scratch.put({ type: piece.type, color: piece.color }, from); continue; }

    const bad = scratch.attackers(ownKing, opponent).length > 0;

    scratch.remove(to);
    scratch.put({ type: piece.type, color: piece.color }, from);
    if (!bad) dests.push(to);
  }
  return dests;
}

// Teleport ONE random non-king piece belonging to `side` (the player who just
// moved) to a random valid empty square. Returns an array of 0 or 1 events
// ({ from, to, piece }); empty when nothing of theirs can legally move (e.g.
// only a king left). Applies the change via surgical FEN edits.
export function runTeleportPhase(chess, rng, side) {
  const eligible = [];
  for (const sq of SQUARES) {
    const p = chess.get(sq);
    if (!p || p.color !== side || p.type === 'k') continue;
    const dests = validTeleportDests(chess, sq);
    if (dests.length) eligible.push({ from: sq, dests });
  }

  if (!eligible.length) return [];
  const chosen = eligible[rng.int(eligible.length)];
  const to = chosen.dests[rng.int(chosen.dests.length)];
  const piece = chess.get(chosen.from);
  const pos = applyTeleport(parseFen(chess.fen()), chosen.from, to);
  chess.load(serializeFen(pos));
  return [{ from: chosen.from, to, piece: { type: piece.type, color: piece.color } }];
}
