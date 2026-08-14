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

// WHEN Magic acts is a hard rule, never a dice roll.
//
// While more than MAGIC_STOPS_AT pieces stand on the board, Magic acts after
// every single move, without exception. The moment the board is down to
// MAGIC_STOPS_AT pieces or fewer, Magic stops for the rest of the game.
//
// It can never switch back on: pieces only ever leave the board (a capture
// removes one, a promotion swaps one for another), so the count never rises.
// Once it stops, it has stopped, and the endgame is plain chess.
//
// This replaced a version where Magic acted with a probability that tapered as
// material ran out. The maths was even-handed but it read as pure caprice:
// pieces would scatter, go quiet for a few turns, then scatter again with no
// visible reason. A rule you cannot predict is not a rule.
//
// The count includes both kings, so it is exactly the number of pieces you can
// see on the board.
export const MAGIC_STOPS_AT = 10;

export function countPieces(chess) {
  let pieces = 0;
  for (const row of chess.board()) {
    for (const cell of row) if (cell) pieces++;
  }
  return pieces;
}

// Is Magic still in play at this position? Depends only on the board.
export function magicIsActive(chess, stopsAt = MAGIC_STOPS_AT) {
  return countPieces(chess) > stopsAt;
}

// Teleport ONE random non-king piece belonging to `side` (the player who just
// moved) to a random valid empty square. Returns an array of 0 or 1 events
// ({ from, to, piece }); empty when nothing of theirs can move or when Magic
// passes this turn. Applies the change via surgical FEN edits.
export function runTeleportPhase(chess, rng, side, { stopsAt = MAGIC_STOPS_AT, report = null } = {}) {
  const onBoard = countPieces(chess);
  if (report) { report.onBoard = onBoard; report.stopped = false; report.eligible = 0; }

  // The hard rule, checked before anything else.
  if (onBoard <= stopsAt) {
    if (report) report.stopped = true;
    return [];
  }

  const eligible = [];
  for (const sq of SQUARES) {
    const p = chess.get(sq);
    if (!p || p.color !== side || p.type === 'k') continue;
    const dests = validTeleportDests(chess, sq);
    if (dests.length) eligible.push({ from: sq, dests });
  }

  if (report) report.eligible = eligible.length;
  if (!eligible.length) return [];

  const chosen = eligible[rng.int(eligible.length)];
  const to = chosen.dests[rng.int(chosen.dests.length)];
  const piece = chess.get(chosen.from);
  const pos = applyTeleport(parseFen(chess.fen()), chosen.from, to);
  chess.load(serializeFen(pos));
  return [{ from: chosen.from, to, piece: { type: piece.type, color: piece.color } }];
}
