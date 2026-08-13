// ChaosMatch: one game of Chess (Motty's Version). Owns the Chess instance,
// the deterministic teleport schedule, and the event log. No DOM here; the UI
// and the tests both drive this.
//
// Turn cycle, forever the same:
//   side to move plays  ->  ONE of that side's non-king pieces teleports
//   ->  game over check  ->  other side plays  ->  ...
//
// White's very first move has no teleport before it: you move, then you
// teleport. Because the teleport is settled before checkmate is evaluated, a
// mating move is only final if it survives the mover's own dice roll: teleport
// your own mating piece away and the mate evaporates. That is the game.

import { Chess } from '../vendor/chess.js';
import { phaseRng } from './rng.js';
import { runTeleportPhase } from './teleport.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export class ChaosMatch {
  constructor(seed) {
    this.seed = seed;
    this.chess = new Chess(START_FEN);
    this.ply = 0;               // half-moves played
    this.teleportPending = false; // a move was played and owes its teleport
    this.log = [];              // { kind: 'move'|'teleport', ... }
    this.resignedBy = null;
    this.startedAt = Date.now();
  }

  turn() { return this.chess.turn(); }
  fen() { return this.chess.fen(); }

  // Settle the teleport owed by the move just played. Returns the events
  // (array of 0 or 1), or null when nothing is owed.
  teleportIfDue() {
    if (!this.teleportPending) return null;
    this.teleportPending = false;
    // the side that just moved is the opposite of whoever is now to move
    const mover = this.chess.turn() === 'w' ? 'b' : 'w';
    const rng = phaseRng(this.seed, this.ply);
    const fenBefore = this.fen();
    const events = runTeleportPhase(this.chess, rng, mover);
    const fenAfter = this.fen();
    for (const ev of events) {
      this.log.push({ kind: 'teleport', ply: this.ply, fenBefore, fenAfter, ...ev });
    }
    return events;
  }

  // Game status. Only meaningful once any owed teleport has been settled.
  status() {
    if (this.resignedBy) {
      return {
        over: true,
        winner: this.resignedBy === 'w' ? 'b' : 'w',
        reason: 'resignation',
      };
    }
    const c = this.chess;
    if (c.isCheckmate()) {
      return { over: true, winner: c.turn() === 'w' ? 'b' : 'w', reason: 'checkmate' };
    }
    if (c.isStalemate()) return { over: true, winner: null, reason: 'stalemate' };
    if (c.isInsufficientMaterial()) {
      return { over: true, winner: null, reason: 'insufficient material' };
    }
    if (Number(c.fen().split(' ')[4]) >= 100) {
      return { over: true, winner: null, reason: 'fifty-move rule' };
    }
    return { over: false, winner: null, reason: null, check: c.isCheck() };
  }

  legalMoves(square) {
    return this.chess.moves(square ? { square, verbose: true } : { verbose: true });
  }

  // Apply a real move for the side to move. Throws if illegal.
  applyMove({ from, to, promotion }) {
    const fenBefore = this.fen();
    const move = this.chess.move({ from, to, promotion: promotion || undefined });
    // '#' is provisional here: mate is only real if it survives the next
    // shuffle, so the log never claims it early.
    const san = move.san.replace('#', '+');
    this.log.push({
      kind: 'move', ply: this.ply, san, uci: move.from + move.to + (move.promotion || ''),
      color: move.color, captured: move.captured || null, flags: move.flags,
      from: move.from, to: move.to, piece: move.piece, promotion: move.promotion || null,
      fenBefore, fenAfter: this.fen(),
    });
    this.ply++;
    this.teleportPending = true;
    return move;
  }

  resign(color) { this.resignedBy = color; }

  // Captured material per side, derived from the move log (teleports never
  // capture, so the log is the whole truth).
  captured() {
    const byWhite = [];
    const byBlack = [];
    for (const e of this.log) {
      if (e.kind === 'move' && e.captured) {
        (e.color === 'w' ? byWhite : byBlack).push(e.captured);
      }
    }
    return { byWhite, byBlack };
  }
}

// Deterministic full-game replay: rebuild a match from its seed and an ordered
// list of UCI moves, interleaving teleports exactly as live play runs them.
export function replayMatch(seed, ucis) {
  const m = new ChaosMatch(seed);
  for (const uci of ucis) {
    if (uci === 'resign:w' || uci === 'resign:b') { m.resign(uci.slice(-1)); return m; }
    m.applyMove({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    m.teleportIfDue();
  }
  return m;
}
