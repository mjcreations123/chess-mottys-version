// Black Hole Chess: both players keep one secret one-use trap on the board.
// When ANY piece lands on it, owner's or opponent's, that piece disappears.
// The trap is then spent, its square is immediately ordinary again, and the
// owner chooses a new empty square before the next chess move.

import { Chess } from '../vendor/chess.js';
import { SQUARES } from './fen.js';
import { makeRng, seedFromString } from './rng.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const MAX_RELOCATIONS = 3;

const otherColor = (color) => color === 'w' ? 'b' : 'w';
const OWN_THIRD_RANK = { w: '3', b: '6' };

export function eligibleBlackHoleSquares(chess, excluded = []) {
  const blocked = new Set(excluded.filter(Boolean));
  return SQUARES.filter((square) => !blocked.has(square) && !chess.get(square));
}

function kingAdjacentSquares(chess) {
  const near = new Set();
  for (const square of SQUARES) {
    const piece = chess.get(square);
    if (!piece || piece.type !== 'k') continue;
    const file = square.charCodeAt(0) - 97;
    const rank = square.charCodeAt(1) - 49;
    for (let df = -1; df <= 1; df++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const f = file + df;
        const r = rank + dr;
        if (f < 0 || f > 7 || r < 0 || r > 7) continue;
        near.add(String.fromCharCode(97 + f) + String(r + 1));
      }
    }
  }
  return near;
}

// Two placement restrictions apply only to a side's very first black hole,
// before any chess has actually been played: it cannot touch either king,
// and it cannot sit on the rank directly in front of that side's own pawns
// (rank 3 for White, rank 6 for Black). Both are opening-only limits. A
// trap earned mid-game by relocating, or re-armed after firing, may go
// anywhere empty — by then the position has moved on and the square was
// found through real chess, not just planted blind on the most obvious
// square in the room.
export function firstBlackHoleEligibleSquares(chess, color, excluded = []) {
  const base = eligibleBlackHoleSquares(chess, excluded);
  const blocked = kingAdjacentSquares(chess);
  const thirdRank = OWN_THIRD_RANK[color];
  if (thirdRank) for (const square of SQUARES) if (square[1] === thirdRank) blocked.add(square);
  const restricted = base.filter((square) => !blocked.has(square));
  // A fallback so a cramped custom position can never stall the game over
  // a rule neither restriction was written to police.
  return restricted.length ? restricted : base;
}

export class BlackHoleMatch {
  constructor(seed) {
    this.seed = seed;
    this.chess = new Chess(START_FEN);
    this.ply = 0;
    this.log = [];
    this.resignedBy = null;
    this.startedAt = Date.now();
    this.blackHoles = { w: null, b: null };
    this.selectionCount = { w: 0, b: 0 };
    this.triggeredCount = { w: 0, b: 0 };
    this.relocationCount = { w: 0, b: 0 };
    this.lastTriggered = { w: null, b: null };
    this.requiredSelections = new Set(['w', 'b']);
    this.resolutionPending = false;
    this.pendingTrigger = null;
    this.blackHoleWin = null;
  }

  turn() { return this.chess.turn(); }
  fen() { return this.chess.fen(); }
  activeBlackHole(color) { return this.blackHoles[color] || null; }
  selectionRequired(color) { return this.requiredSelections.has(color); }
  readyToPlay() { return this.requiredSelections.size === 0; }
  lastTriggeredSquare(color) { return this.lastTriggered[color] || null; }
  blackHolesTriggered(color) {
    return color ? (this.triggeredCount[color] || 0) : this.triggeredCount.w + this.triggeredCount.b;
  }
  relocationsUsed(color) { return this.relocationCount[color] || 0; }
  relocationsRemaining(color) { return Math.max(0, MAX_RELOCATIONS - this.relocationsUsed(color)); }

  eligibleBlackHoles(color) {
    if (!['w', 'b'].includes(color)) return [];
    return this.selectionCount[color] === 0
      ? firstBlackHoleEligibleSquares(this.chess, color)
      : eligibleBlackHoleSquares(this.chess);
  }

  eligibleRelocationSquares(color) {
    if (!['w', 'b'].includes(color) || !this.blackHoles[color]) return [];
    return eligibleBlackHoleSquares(this.chess, [this.blackHoles[color]]);
  }

  canRelocateBlackHole(color) {
    return ['w', 'b'].includes(color)
      && this.turn() === color
      && this.readyToPlay()
      && !this.resolutionPending
      && !this.status().over
      && !this.chess.isCheck()
      && Boolean(this.blackHoles[color])
      && this.relocationsRemaining(color) > 0
      && this.eligibleRelocationSquares(color).length > 0;
  }

  selectBlackHole(color, square, { automatic = false } = {}) {
    if (!['w', 'b'].includes(color)) throw new Error(`invalid black-hole color ${color}`);
    if (!this.requiredSelections.has(color) || this.blackHoles[color]) {
      throw new Error(`${color} already has an active black hole`);
    }
    if (!this.eligibleBlackHoles(color).includes(square)) {
      throw new Error(`black hole cannot be placed on ${square}`);
    }

    // Secret choices may share a square. Each trap still belongs to its
    // owner and fires independently, so a landing there later can spend one
    // trap or both, depending on whether one or both owners chose it.
    this.blackHoles[color] = square;
    this.requiredSelections.delete(color);
    const sequence = ++this.selectionCount[color];
    const event = {
      kind: 'placement',
      ply: this.ply,
      color,
      square,
      sequence,
      automatic,
      previousSquare: this.lastTriggered[color],
      fenAfter: this.fen(),
    };
    this.log.push(event);
    return event;
  }

  // Deterministic last-resort placement for recovery paths and fuzz tests.
  // The public game uses the difficulty-aware strategist in hole-strategy.js.
  selectFallbackBlackHole(color, excluded = []) {
    const choices = this.selectionCount[color] === 0
      ? firstBlackHoleEligibleSquares(this.chess, color, excluded)
      : eligibleBlackHoleSquares(this.chess, excluded);
    if (!choices.length) {
      this.requiredSelections.delete(color);
      return null;
    }
    const sequence = this.selectionCount[color] + 1;
    const rng = makeRng(seedFromString(`${this.seed}#black-hole#${color}#${sequence}`));
    return this.selectBlackHole(color, choices[rng.int(choices.length)], { automatic: true });
  }

  relocateBlackHole(color, square, { automatic = false } = {}) {
    if (!['w', 'b'].includes(color)) throw new Error(`invalid black-hole color ${color}`);
    if (this.turn() !== color) throw new Error(`it is not ${color}'s turn`);
    if (!this.readyToPlay()) throw new Error('black-hole selection required');
    if (this.resolutionPending) throw new Error('black-hole resolution pending');
    if (this.status().over) throw new Error('game is over');
    if (this.chess.isCheck()) throw new Error('cannot relocate while in check');
    if (!this.blackHoles[color]) throw new Error(`${color} has no active black hole`);
    if (this.relocationsRemaining(color) <= 0) throw new Error(`${color} has no relocations left`);

    const from = this.blackHoles[color];
    if (square === from) throw new Error('choose a different black-hole square');
    if (!this.eligibleRelocationSquares(color).includes(square)) {
      throw new Error(`black hole cannot be relocated to ${square}`);
    }

    const fenBefore = this.fen();
    // A voluntary relocation is the whole turn. chess.js's null move keeps
    // castling rights, advances the clocks, expires en passant and changes the
    // side to move without changing any piece square.
    this.chess.move('--');

    this.blackHoles[color] = square;
    const used = ++this.relocationCount[color];
    const event = {
      kind: 'relocation',
      ply: this.ply,
      color,
      from,
      to: square,
      used,
      remaining: this.relocationsRemaining(color),
      automatic,
      fenBefore,
      fenAfter: this.fen(),
    };
    this.log.push(event);
    this.ply++;
    return event;
  }

  status() {
    if (this.resignedBy) {
      return {
        over: true,
        winner: otherColor(this.resignedBy),
        reason: 'resignation',
      };
    }
    if (this.blackHoleWin) {
      return {
        over: true,
        winner: this.blackHoleWin.winner,
        reason: 'black hole',
        blackHole: this.blackHoleWin,
      };
    }
    const c = this.chess;
    if (c.isCheckmate()) {
      return { over: true, winner: otherColor(c.turn()), reason: 'checkmate' };
    }
    if (c.isStalemate()) return { over: true, winner: null, reason: 'stalemate' };
    // Black holes can still decide bare-king positions, so ordinary
    // insufficient-material draws do not apply to this variant.
    if (Number(c.fen().split(' ')[4]) >= 100) {
      return { over: true, winner: null, reason: 'fifty-move rule' };
    }
    return { over: false, winner: null, reason: null, check: c.isCheck() };
  }

  legalMoves(square) {
    if (!this.readyToPlay() || this.resolutionPending || this.status().over) return [];
    return this.chess.moves(square ? { square, verbose: true } : { verbose: true });
  }

  applyMove({ from, to, promotion }) {
    if (!this.readyToPlay()) throw new Error('black-hole selection required');
    if (this.resolutionPending) throw new Error('black-hole resolution pending');
    if (this.status().over) throw new Error('game is over');

    const fenBefore = this.fen();
    const move = this.chess.move({ from, to, promotion: promotion || undefined });
    const landings = [{
      square: move.to,
      piece: { color: move.color, type: move.promotion || move.piece },
      role: 'moved piece',
    }];

    if (move.isKingsideCastle()) {
      landings.push({
        square: move.color === 'w' ? 'f1' : 'f8',
        piece: { color: move.color, type: 'r' },
        role: 'castling rook',
      });
    } else if (move.isQueensideCastle()) {
      landings.push({
        square: move.color === 'w' ? 'd1' : 'd8',
        piece: { color: move.color, type: 'r' },
        role: 'castling rook',
      });
    }

    // A trap now catches anything that lands on it, its own owner included,
    // so every landing is checked against both players' traps rather than
    // only the mover's opponent. The two traps may legally share a square
    // (each side picks in secret); a landing there spends both at once.
    const triggers = [];
    for (const landing of landings) {
      for (const owner of ['w', 'b']) {
        if (this.blackHoles[owner] === landing.square) triggers.push({ owner, ...landing });
      }
    }

    const entry = {
      kind: 'move',
      ply: this.ply,
      san: move.san,
      uci: move.from + move.to + (move.promotion || ''),
      color: move.color,
      captured: move.captured || null,
      flags: move.flags,
      from: move.from,
      to: move.to,
      piece: move.piece,
      promotion: move.promotion || null,
      fenBefore,
      fenAfter: this.fen(),
    };
    this.log.push(entry);
    this.ply++;
    this.resolutionPending = true;
    this.pendingTrigger = triggers.length ? { move, moveEntry: entry, triggers } : null;
    return move;
  }

  // Settle the trap check owed by the move just played. Returns null when no
  // move is awaiting settlement, [] when the move was safe, or one event per
  // trap that fired (normally one; two only when a shared square catches
  // both owners at once).
  resolveBlackHoleIfDue() {
    if (!this.resolutionPending) return null;
    this.resolutionPending = false;
    const pending = this.pendingTrigger;
    this.pendingTrigger = null;
    if (!pending) return [];

    const events = [];
    for (const trigger of pending.triggers) {
      const fenBefore = this.fen();
      // A shared square means a second trigger can arrive after the first
      // already removed the piece. It still spends its owner's trap and
      // still requires a re-arm; it just finds nothing left to remove.
      if (this.chess.get(trigger.square)) {
        this.chess.remove(trigger.square);
        this.chess.resetHalfMoves();
      }

      this.blackHoles[trigger.owner] = null;
      this.lastTriggered[trigger.owner] = trigger.square;
      this.triggeredCount[trigger.owner]++;

      const victimColor = trigger.piece.color;
      if (trigger.piece.type === 'k') {
        // Losing a king loses the game for that king's own side, whether the
        // trap that caught it was the opponent's or the victim's own.
        if (!this.blackHoleWin) {
          this.blackHoleWin = {
            winner: otherColor(victimColor),
            victim: victimColor,
            square: trigger.square,
            piece: trigger.piece.type,
            cause: 'king-fell',
          };
        }
      } else if (!this.blackHoleWin) {
        this.requiredSelections.add(trigger.owner);
        if (!this.eligibleBlackHoles(trigger.owner).length) {
          this.requiredSelections.delete(trigger.owner);
        }
      }

      events.push({
        kind: 'black-hole',
        ply: this.ply,
        owner: trigger.owner,
        victimColor,
        square: trigger.square,
        piece: trigger.piece,
        role: trigger.role,
        fenBefore,
        fenAfter: this.fen(),
        reopened: true,
        kingLost: trigger.piece.type === 'k',
      });
    }

    const baseSan = pending.move.san.replace(/[+#]$/, '');
    const finalStatus = this.status();
    const suffix = finalStatus.reason === 'checkmate' ? '#'
      : (!finalStatus.over && this.chess.isCheck()) ? '+' : '';
    pending.move.san = baseSan + suffix;
    pending.moveEntry.san = pending.move.san;

    this.log.push(...events);
    return events;
  }

  resign(color) {
    this.resignedBy = color;
    this.log.push({ kind: 'resign', color, ply: this.ply });
  }

  captured() {
    const byWhite = [];
    const byBlack = [];
    for (const event of this.log) {
      if (event.kind === 'move' && event.captured) {
        (event.color === 'w' ? byWhite : byBlack).push(event.captured);
      } else if (event.kind === 'black-hole') {
        (event.owner === 'w' ? byWhite : byBlack).push(event.piece.type);
      }
    }
    return { byWhite, byBlack };
  }

  serializedActions() {
    return this.log.flatMap((event) => {
      if (event.kind === 'placement') {
        return [{ kind: 'place', color: event.color, square: event.square, automatic: event.automatic }];
      }
      if (event.kind === 'relocation') {
        return [{ kind: 'relocate', color: event.color, from: event.from, to: event.to, automatic: event.automatic }];
      }
      if (event.kind === 'move') return [{ kind: 'move', uci: event.uci }];
      if (event.kind === 'resign') return [{ kind: 'resign', color: event.color }];
      return [];
    });
  }
}

export function replayMatch(seed, actions) {
  const match = new BlackHoleMatch(seed);
  for (const action of actions) {
    if (action?.kind === 'place') {
      // Versions 6 and 7 resolved a shared-square choice by deleting the
      // earlier trap, followed by another placement action for its owner.
      // Accept that historical action shape while all new games allow both
      // traps to remain on the same square.
      if (match.activeBlackHole(action.color)) {
        match.blackHoles[action.color] = null;
        match.requiredSelections.add(action.color);
      }
      match.selectBlackHole(action.color, action.square, { automatic: Boolean(action.automatic) });
    } else if (action?.kind === 'relocate') {
      if (action.from && match.activeBlackHole(action.color) !== action.from) {
        throw new Error('relocation origin does not match the active black hole');
      }
      match.relocateBlackHole(action.color, action.to, { automatic: Boolean(action.automatic) });
    } else if (action?.kind === 'move' && typeof action.uci === 'string') {
      match.applyMove({
        from: action.uci.slice(0, 2),
        to: action.uci.slice(2, 4),
        promotion: action.uci[4],
      });
      match.resolveBlackHoleIfDue();
    } else if (action?.kind === 'resign') {
      match.resign(action.color);
    } else {
      throw new Error('invalid replay action');
    }
  }
  return match;
}
