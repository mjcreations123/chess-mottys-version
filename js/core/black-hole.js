// Black Hole Chess: both players keep one secret trap on the board. When an
// opposing piece lands on it, that piece disappears, the square collapses for
// the rest of the game, and the trap's owner must choose a replacement before
// play continues.

import { Chess } from '../vendor/chess.js';
import { SQUARES } from './fen.js';
import { makeRng, seedFromString } from './rng.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const otherColor = (color) => color === 'w' ? 'b' : 'w';

export function eligibleBlackHoleSquares(chess, collapsed = [], excluded = []) {
  const blocked = new Set([...collapsed, ...excluded].filter(Boolean));
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
    this.collapsed = new Set();
    this.selectionCount = { w: 0, b: 0 };
    this.requiredSelections = new Set(['w', 'b']);
    this.resolutionPending = false;
    this.pendingTrigger = null;
    this.blackHoleWin = null;
    this.chess.setHoles([]);
  }

  turn() { return this.chess.turn(); }
  fen() { return this.chess.fen(); }
  collapsedSquares() { return [...this.collapsed]; }
  activeBlackHole(color) { return this.blackHoles[color] || null; }
  selectionRequired(color) { return this.requiredSelections.has(color); }
  readyToPlay() { return this.requiredSelections.size === 0; }

  eligibleBlackHoles(color) {
    if (!['w', 'b'].includes(color)) return [];
    return eligibleBlackHoleSquares(this.chess, this.collapsed);
  }

  selectBlackHole(color, square, { automatic = false } = {}) {
    if (!['w', 'b'].includes(color)) throw new Error(`invalid black-hole color ${color}`);
    if (!this.requiredSelections.has(color) || this.blackHoles[color]) {
      throw new Error(`${color} already has an active black hole`);
    }
    if (!this.eligibleBlackHoles(color).includes(square)) {
      throw new Error(`black hole cannot be placed on ${square}`);
    }

    // Secret choices may collide. The latest choice keeps the square and the
    // displaced hidden trap is immediately reselected by its owner. The player
    // is never told that their choice happened to collide with MottyBot's.
    const opponent = otherColor(color);
    let displaced = null;
    if (this.blackHoles[opponent] === square) {
      this.blackHoles[opponent] = null;
      this.requiredSelections.add(opponent);
      displaced = opponent;
    }

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
      displaced,
      fenAfter: this.fen(),
      collapsed: this.collapsedSquares(),
    };
    this.log.push(event);
    return event;
  }

  selectRandomBlackHole(color) {
    const opponent = otherColor(color);
    const excluded = this.blackHoles[opponent] ? [this.blackHoles[opponent]] : [];
    const choices = eligibleBlackHoleSquares(this.chess, this.collapsed, excluded);
    if (!choices.length) {
      this.requiredSelections.delete(color);
      return null;
    }
    const sequence = this.selectionCount[color] + 1;
    const rng = makeRng(seedFromString(`${this.seed}#black-hole#${color}#${sequence}`));
    return this.selectBlackHole(color, choices[rng.int(choices.length)], { automatic: true });
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
    const holesBefore = this.collapsedSquares();
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
      collapsed: holesBefore,
    };
    this.log.push(entry);
    this.ply++;
    this.resolutionPending = true;
    this.pendingTrigger = landing ? { owner: opponent, move, moveEntry: entry, ...landing } : null;
    return move;
  }

  // Settle the trap check owed by the move just played. Returns null when no
  // move is awaiting settlement, [] when the move was safe, or one collapse.
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
    this.collapsed.add(trigger.square);
    this.chess.setHoles(this.collapsed);

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
      collapsed: this.collapsedSquares(),
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
      if (event.kind === 'placement') return [{ kind: 'place', color: event.color, square: event.square }];
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
      match.selectBlackHole(action.color, action.square, { automatic: action.color !== 'w' });
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
