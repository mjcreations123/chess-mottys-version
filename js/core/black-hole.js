// Black Hole Chess: both players keep one secret one-use trap on the board.
// When an opposing piece lands on it, that piece disappears. The trap is then
// spent, its square is immediately ordinary again, and the owner chooses a new
// empty square before the next chess move.

import { Chess } from '../vendor/chess.js';
import { SQUARES } from './fen.js';
import { makeRng, seedFromString } from './rng.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const MAX_RELOCATIONS = 3;

const otherColor = (color) => color === 'w' ? 'b' : 'w';

export function eligibleBlackHoleSquares(chess, excluded = []) {
  const blocked = new Set(excluded.filter(Boolean));
  return SQUARES.filter((square) => !blocked.has(square) && !chess.get(square));
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
    return eligibleBlackHoleSquares(this.chess);
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

    // Secret choices may share a square. Each trap still belongs to its owner
    // and affects only the opponent, so one landing consumes exactly one trap
    // and can never force both players to re-arm.
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
    const choices = eligibleBlackHoleSquares(this.chess, excluded);
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
    const opponent = otherColor(move.color);
    const active = this.blackHoles[opponent];
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

    const landing = active ? landings.find((item) => item.square === active) : null;
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
    this.pendingTrigger = landing ? { owner: opponent, move, moveEntry: entry, ...landing } : null;
    return move;
  }

  // Settle the trap check owed by the move just played. Returns null when no
  // move is awaiting settlement, [] when the move was safe, or one trigger.
  resolveBlackHoleIfDue() {
    if (!this.resolutionPending) return null;
    this.resolutionPending = false;
    const trigger = this.pendingTrigger;
    this.pendingTrigger = null;
    if (!trigger) return [];

    const fenBefore = this.fen();
    const removed = this.chess.remove(trigger.square);
    if (!removed) throw new Error(`black hole on ${trigger.square} found no landing piece`);
    this.chess.resetHalfMoves();

    this.blackHoles[trigger.owner] = null;
    this.lastTriggered[trigger.owner] = trigger.square;
    this.triggeredCount[trigger.owner]++;

    const victimColor = trigger.piece.color;
    if (trigger.piece.type === 'k') {
      this.blackHoleWin = {
        winner: trigger.owner,
        victim: victimColor,
        square: trigger.square,
        piece: trigger.piece.type,
        cause: 'king-fell',
      };
    } else {
      this.requiredSelections.add(trigger.owner);
      if (!this.eligibleBlackHoles(trigger.owner).length) {
        this.requiredSelections.delete(trigger.owner);
      }
    }

    const baseSan = trigger.move.san.replace(/[+#]$/, '');
    const finalStatus = this.status();
    const suffix = finalStatus.reason === 'checkmate' ? '#'
      : (!finalStatus.over && this.chess.isCheck()) ? '+' : '';
    trigger.move.san = baseSan + suffix;
    trigger.moveEntry.san = trigger.move.san;

    const event = {
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
    };
    this.log.push(event);
    return [event];
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
