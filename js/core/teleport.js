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

// Fate acts on every turn while you have a real army, and eases off as your
// army disappears.
//
// Why: one piece is drawn from your eligible pieces, so the chance that any
// GIVEN piece of yours is thrown across the board is 1/n. At sixteen pieces
// that is background noise. At one piece it is a certainty, and your last
// rook is somewhere new every single turn, which makes an endgame impossible
// to play rather than merely chaotic. That is a hidden penalty on whoever has
// less material.
//
// So the chance Fate acts at all is n / FULL_FORCE_AT, capped at 1. The chance
// a given piece is moved becomes (n / FULL_FORCE_AT) * (1 / n) = 1 /
// FULL_FORCE_AT: a constant, no matter how much material is left. Openings and
// middlegames are untouched, because n is already at or above the threshold.
export const FULL_FORCE_AT = 8;

export function teleportChance(eligibleCount, fullForceAt = FULL_FORCE_AT) {
  if (eligibleCount <= 0) return 0;
  return Math.min(1, eligibleCount / fullForceAt);
}

// Teleport ONE random non-king piece belonging to `side` (the player who just
// moved) to a random valid empty square. Returns an array of 0 or 1 events
// ({ from, to, piece }); empty when nothing of theirs can move or when Fate
// passes this turn. Applies the change via surgical FEN edits.
export function runTeleportPhase(chess, rng, side, { fullForceAt = FULL_FORCE_AT, report = null } = {}) {
  const eligible = [];
  for (const sq of SQUARES) {
    const p = chess.get(sq);
    if (!p || p.color !== side || p.type === 'k') continue;
    const dests = validTeleportDests(chess, sq);
    if (dests.length) eligible.push({ from: sq, dests });
  }

  if (report) { report.eligible = eligible.length; report.passed = false; }
  if (!eligible.length) return [];

  // Draw the pass roll before the piece so the sequence stays deterministic.
  if (rng.next() >= teleportChance(eligible.length, fullForceAt)) {
    if (report) report.passed = true;
    return [];
  }

  const chosen = eligible[rng.int(eligible.length)];
  const to = chosen.dests[rng.int(chosen.dests.length)];
  const piece = chess.get(chosen.from);
  const pos = applyTeleport(parseFen(chess.fen()), chosen.from, to);
  chess.load(serializeFen(pos));
  return [{ from: chosen.from, to, piece: { type: piece.type, color: piece.color } }];
}
