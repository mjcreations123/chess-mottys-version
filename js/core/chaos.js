// ChaosMatch: one game of Chess (Motty's Version). Owns the Chess instance,
// the deterministic teleport schedule, and the event log. No DOM here; the UI
// and the tests both drive this.
//
// Turn cycle, forever the same:
//   side to move plays  ->  if the game ended, STOP  ->  otherwise, if more
//   than MAGIC_STOPS_AT pieces remain, ONE of that side's non-king pieces
//   teleports  ->  other side plays  ->  ...
//
// White's very first move has no teleport before it: you move, then you
// teleport. A finished game is finished: checkmate, stalemate, a dead position
// or the fifty-move rule all end the game the instant the move lands, and no
// teleport follows. Nothing can undo a checkmate.

import { Chess } from '../vendor/chess.js';
import { phaseRng } from './rng.js';
import { runTeleportPhase, magicIsActive, countPieces, MAGIC_STOPS_AT } from './teleport.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export class ChaosMatch {
  constructor(seed, { stopsAt } = {}) {
    this.seed = seed;
    this.stopsAt = stopsAt;
    this.lastPhase = null; // { eligible, passed } for the most recent teleport
    this.chess = new Chess(START_FEN);
    this.ply = 0;               // half-moves played
    this.teleportPending = false; // a move was played and owes its teleport
    this.log = [];              // { kind: 'move'|'teleport', ... }
    this.resignedBy = null;
    this.startedAt = Date.now();
  }

  turn() { return this.chess.turn(); }
  fen() { return this.chess.fen(); }

  // The house rule's state, readable at any moment so the UI never has to
  // guess: how many pieces are on the board, the count Magic stops at, and how
  // many captures are left before it goes quiet for good.
  magicState() {
    const stopsAt = this.stopsAt ?? MAGIC_STOPS_AT;
    const onBoard = countPieces(this.chess);
    return {
      onBoard,
      stopsAt,
      active: onBoard > stopsAt,
      untilStop: Math.max(0, onBoard - stopsAt),
    };
  }

  // Settle the teleport owed by the move just played. Returns the events
  // (array of 0 or 1), or null when nothing is owed.
  teleportIfDue() {
    if (!this.teleportPending) return null;
    this.teleportPending = false;
    // A finished game is finished. The teleport never gets a chance to undo a
    // checkmate, a stalemate or a drawn position.
    if (this.status().over) {
      this.lastPhase = { eligible: 0, stopped: false, ended: true };
      return [];
    }
    // the side that just moved is the opposite of whoever is now to move
    const mover = this.chess.turn() === 'w' ? 'b' : 'w';
    const rng = phaseRng(this.seed, this.ply);
    const fenBefore = this.fen();
    const report = {};
    const options = { report };
    if (this.stopsAt !== undefined) options.stopsAt = this.stopsAt;
    const events = runTeleportPhase(this.chess, rng, mover, options);
    this.lastPhase = report;
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
    // Checkmate is final now, so '#' means exactly what it says.
    this.log.push({
      kind: 'move', ply: this.ply, san: move.san, uci: move.from + move.to + (move.promotion || ''),
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
