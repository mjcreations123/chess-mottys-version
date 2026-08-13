// The house rule. Before every turn, two random pieces teleport to random
// empty squares. All draws are deterministic given the phase rng, so two
// multiplayer clients replaying the same seed and move list see identical
// chaos.
//
// A destination is valid when, after the piece is lifted and dropped there:
//   1. the square was empty (teleports never capture);
//   2. pawns never sit on rank 1 or 8;
//   3. the king of the side NOT about to move has zero attackers
//      (no position where a player could capture the king);
//   4. the king of the side about to move gains no NEW attackers; a check
//      that already existed from a real move may persist or dissolve, but a
//      teleport never creates one;
//   5. a teleporting KING must land with zero attackers on it, full stop
//      (kings only go to safe squares, and teleporting out of a real check
//      resolves it).

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
  if (!piece) return [];
  const S = chess.turn();
  const T = S === 'w' ? 'b' : 'w';

  const scratch = new Chess(chess.fen());
  const kS = findKing(scratch, S);
  const kT = findKing(scratch, T);
  const preCheckers = scratch.attackers(kS, T);

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

    let kS2 = kS;
    let kT2 = kT;
    if (piece.type === 'k') {
      if (piece.color === S) kS2 = to; else kT2 = to;
    }

    let bad = scratch.attackers(kT2, S).length > 0; // rule 3 (and rule 5 for T's king)
    if (!bad) {
      const checkers = scratch.attackers(kS2, T);
      if (piece.type === 'k' && piece.color === S) {
        bad = checkers.length > 0; // rule 5 for S's king
      } else {
        bad = !checkers.every((sq) => preCheckers.includes(sq)); // rule 4
      }
    }

    scratch.remove(to);
    scratch.put({ type: piece.type, color: piece.color }, from);
    if (!bad) dests.push(to);
  }
  return dests;
}

// Run one pre-turn phase: up to `count` of the SIDE TO MOVE's own pieces
// teleport (before your turn, one of YOUR pieces moves; the opponent's stay
// put until their turn). Returns the events ({ from, to, piece }) performed,
// applying each to the live Chess instance via surgical FEN edits.
export function runTeleportPhase(chess, rng, count = 1) {
  const events = [];
  const movedTo = new Set();
  const side = chess.turn();

  for (let k = 0; k < count; k++) {
    const occupied = [];
    for (const sq of SQUARES) {
      const p = chess.get(sq);
      if (p && p.color === side && !movedTo.has(sq)) occupied.push(sq);
    }
    const order = rng.shuffle(occupied);

    let done = false;
    for (const from of order) {
      const dests = validTeleportDests(chess, from);
      if (!dests.length) continue;
      const to = dests[rng.int(dests.length)];
      const piece = chess.get(from);
      const pos = applyTeleport(parseFen(chess.fen()), from, to);
      chess.load(serializeFen(pos));
      movedTo.add(to);
      events.push({ from, to, piece: { type: piece.type, color: piece.color } });
      done = true;
      break;
    }
    if (!done) break; // nothing on the board can legally teleport
  }
  return events;
}
