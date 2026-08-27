// Prisoner Exchange: this week's rules. Ordinary chess, except every piece
// remembers its starting square, and your dead wait in a graveyard. Capture an
// enemy piece that matches one of your dead (knight, bishop, rook or queen)
// and you may choose, instead of the capture standing, to undo the take and
// bring your own piece home: their piece survives where it stood, yours
// reappears on its starting square, and your turn ends. Pawns play normal
// chess but are outside the trade entirely.

import { Chess } from '../vendor/chess.js';
import { makeRng, seedFromString } from './rng.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const otherColor = (color) => color === 'w' ? 'b' : 'w';
const backRank = (color) => color === 'w' ? '1' : '8';

// Where each type began the game. A promoted piece never stood on any of
// these, so when one dies it adopts the standard squares of its new type and
// may come home to whichever of them is open.
export function canonicalHomes(type, color) {
  const rank = backRank(color);
  switch (type) {
    case 'q': return ['d' + rank];
    case 'r': return ['a' + rank, 'h' + rank];
    case 'n': return ['b' + rank, 'g' + rank];
    case 'b': return ['c' + rank, 'f' + rank];
    default: return [];
  }
}

// The board state a resurrection produces, or null when it would be illegal
// (occupied home, or the mover's king still in check afterward). Shared with
// the worker so MottyBot evaluates exactly the position the rules produce.
export function resurrectionFen(fen, type, color, home) {
  const chess = new Chess(fen);
  if (chess.turn() !== color) return null;
  if (chess.get(home)) return null;
  chess.put({ type, color }, home);
  // You may never end your turn with your own king in check. If the mover is
  // in check right now, only a placement that blocks the check is legal.
  if (chess.isCheck()) return null;
  chess.move('--');
  chess.resetHalfMoves();
  return chess.fen();
}

export class ExchangeMatch {
  constructor(seed) {
    this.seed = seed;
    this.chess = new Chess(START_FEN);
    this.ply = 0;
    this.log = [];
    this.resignedBy = null;
    this.startedAt = Date.now();
    // Where the piece currently on each square began the game. Promotion
    // replaces the entry with a marker, because the new piece has no single
    // birthplace of its own.
    this.origins = new Map();
    for (const [square, piece] of this.#boardEntries()) {
      void piece;
      this.origins.set(square, { home: square });
    }
    // Each side's dead. Pawns are listed (the captured row shows them) but
    // carry no homes and can never return.
    this.dead = { w: [], b: [] };
    // Threefold repetition, tracked here rather than through chess.js:
    // resurrection places pieces outside the move system, so the library's
    // own repetition count cannot be trusted after one.
    this.positionCounts = new Map();
    this.repetitionDraw = false;
    // Set while a played capture is still waiting on a keep-or-come-home
    // decision, and carries what a rollback would need.
    this.pendingOffer = null;
    this.#countPosition();
  }

  #countPosition() {
    const [board, turn, castling, ep] = this.chess.fen().split(' ');
    // The graveyards are part of the position: the same board with different
    // dead pieces offers different futures, so it is not the same position.
    // (Piece identity inside the origin map is ignored, the same way ordinary
    // repetition ignores which of two identical knights stands where.)
    const grave = (color) => this.dead[color]
      .map((entry) => entry.type + (entry.homes ? entry.homes.join('') : ''))
      .sort()
      .join(',');
    const key = `${board} ${turn} ${castling} ${ep} | ${grave('w')} | ${grave('b')}`;
    const count = (this.positionCounts.get(key) || 0) + 1;
    this.positionCounts.set(key, count);
    if (count >= 3) this.repetitionDraw = true;
  }

  #boardEntries() {
    const entries = [];
    for (const row of this.chess.board()) {
      for (const cell of row) {
        if (cell) entries.push([cell.square, cell]);
      }
    }
    return entries;
  }

  turn() { return this.chess.turn(); }
  fen() { return this.chess.fen(); }

  status() {
    if (this.resignedBy) {
      return { over: true, winner: otherColor(this.resignedBy), reason: 'resignation' };
    }
    const c = this.chess;
    if (c.isCheckmate()) return { over: true, winner: otherColor(c.turn()), reason: 'checkmate' };
    if (c.isStalemate()) return { over: true, winner: null, reason: 'stalemate' };
    // Two bare kings can never capture, so nothing can ever return either:
    // the game is over on the spot rather than shuffling to the move counter.
    if (this.#boardEntries().length === 2) {
      return { over: true, winner: null, reason: 'bare kings' };
    }
    if (this.repetitionDraw) return { over: true, winner: null, reason: 'threefold repetition' };
    if (Number(c.fen().split(' ')[4]) >= 100) {
      return { over: true, winner: null, reason: 'fifty-move rule' };
    }
    return { over: false, winner: null, reason: null, check: c.isCheck() };
  }

  legalMoves(square) {
    if (this.status().over) return [];
    return this.chess.moves(square ? { square, verbose: true } : { verbose: true });
  }

  // The victim's square for a capture: the destination, except en passant.
  #victimSquare(move) {
    if (move.flags.includes('e')) return move.to[0] + (move.color === 'w' ? '5' : '4');
    return move.to;
  }

  // Everything a rollback needs. Only taken when the move about to be played
  // could offer a homecoming, which is rare, so the copying costs nothing in
  // the ordinary case.
  #snapshot() {
    return {
      fen: this.chess.fen(),
      origins: new Map(this.origins),
      dead: { w: this.dead.w.slice(), b: this.dead.b.slice() },
      positionCounts: new Map(this.positionCounts),
      repetitionDraw: this.repetitionDraw,
      logLength: this.log.length,
      ply: this.ply,
    };
  }

  #restore(snapshot) {
    this.chess.load(snapshot.fen);
    this.origins = snapshot.origins;
    this.dead = snapshot.dead;
    this.positionCounts = snapshot.positionCounts;
    this.repetitionDraw = snapshot.repetitionDraw;
    this.log.length = snapshot.logLength;
    this.ply = snapshot.ply;
  }

  // A cheap gate so an ordinary move never pays for the full eligibility
  // search: there must be an enemy non-pawn standing on the target square
  // and a matching dead piece with somewhere to come home to.
  #couldOffer(to) {
    const color = this.chess.turn();
    const victim = this.chess.get(to);
    if (!victim || victim.type === 'p' || victim.color === color) return false;
    return this.#eligibleEntries(color, victim.type).length > 0;
  }

  applyMove({ from, to, promotion }) {
    if (this.status().over) throw new Error('game is over');
    // The capture is played for real first, so the board can show it being
    // taken before anyone decides whether to take it back. If it turns out
    // to offer a homecoming, keep everything needed to roll it back.
    const offer = this.#couldOffer(to) ? this.resurrectionOptions({ from, to, promotion }) : null;
    const snapshot = offer ? this.#snapshot() : null;
    this.pendingOffer = null;
    const move = this.chess.move({ from, to, promotion: promotion || undefined });

    if (move.captured) {
      const victimColor = otherColor(move.color);
      const victimSquare = this.#victimSquare(move);
      const origin = this.origins.get(victimSquare);
      this.origins.delete(victimSquare);
      // An ORIGINAL piece remembers exactly the one square it started on:
      // the b8 knight comes home to b8, never g8. Only a promoted piece,
      // which never had a back-rank birthplace, adopts the standard squares
      // of its type. This per-piece identity is the rule as specified, so a
      // dead entry's homes must come from the origin map, not from the
      // type's canonical list.
      const homes = move.captured === 'p' ? null
        : origin && origin.home ? [origin.home]
          : canonicalHomes(move.captured, victimColor);
      this.dead[victimColor].push({ type: move.captured, homes });
    }

    const moverOrigin = this.origins.get(move.from) || { home: move.from };
    this.origins.delete(move.from);
    this.origins.set(move.to, move.promotion ? { promoted: move.promotion } : moverOrigin);

    if (move.isKingsideCastle() || move.isQueensideCastle()) {
      const rank = move.color === 'w' ? '1' : '8';
      const rookFrom = (move.isKingsideCastle() ? 'h' : 'a') + rank;
      const rookTo = (move.isKingsideCastle() ? 'f' : 'd') + rank;
      const rookOrigin = this.origins.get(rookFrom) || { home: rookFrom };
      this.origins.delete(rookFrom);
      this.origins.set(rookTo, rookOrigin);
    }

    this.log.push({
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
      fenBefore: move.before,
      fenAfter: this.fen(),
    });
    this.ply++;
    this.#countPosition();
    if (offer) {
      this.pendingOffer = { offer, snapshot, move: { from, to, promotion: promotion || undefined } };
    }
    return move;
  }

  // The homecoming still on the table for the move just played, or null.
  pendingResurrection() {
    return this.pendingOffer ? this.pendingOffer.offer : null;
  }

  // Let the capture stand. Nothing to undo; the offer simply lapses.
  keepCapture() {
    this.pendingOffer = null;
  }

  // Take the capture back and bring a piece home instead. The board has
  // already shown the piece being taken, so the caller animates the reverse.
  takeHomecoming(home) {
    const pending = this.pendingOffer;
    if (!pending) throw new Error('no homecoming is pending');
    this.pendingOffer = null;
    const undone = this.log[pending.snapshot.logLength];
    this.#restore(pending.snapshot);
    const event = this.resurrect({ ...pending.move, home });
    event.undone = undone;
    return event;
  }

  // Entries of this type whose home is open right now, most constrained
  // first: a piece with one possible home outranks a promoted piece that may
  // use either standard square, so resurrecting to a shared square never
  // wastes the flexible entry.
  #eligibleEntries(color, type) {
    return this.dead[color]
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.type === type && entry.homes
        && entry.homes.some((home) => !this.chess.get(home)))
      .sort((a, b) => (a.entry.homes.length - b.entry.homes.length) || (a.index - b.index));
  }

  // What a capture offers the mover: null when the move is not an eligible
  // capture, otherwise the victim type and every open home square the mover
  // could bring a matching dead piece back to. Evaluated on the CURRENT
  // position: the victim may itself be standing on the home square, and a
  // home the victim occupies stays blocked because the victim survives.
  resurrectionOptions({ from, to, promotion }) {
    if (this.status().over) return null;
    const color = this.chess.turn();
    const move = this.legalMoves(from).find((m) => m.from === from && m.to === to
      && (m.promotion || undefined) === (promotion || undefined));
    if (!move || !move.captured || move.captured === 'p') return null;

    const homes = [];
    for (const { entry } of this.#eligibleEntries(color, move.captured)) {
      for (const home of entry.homes) {
        if (!this.chess.get(home) && !homes.includes(home)
          && resurrectionFen(this.fen(), move.captured, color, home)) {
          homes.push(home);
        }
      }
    }
    if (!homes.length) return null;
    return { victimType: move.captured, victimSquare: this.#victimSquare(move), homes };
  }

  // The whole turn: the capture is declined, their piece survives untouched,
  // and the mover's dead piece returns to its starting square instead.
  resurrect({ from, to, promotion, home }) {
    this.pendingOffer = null;
    const options = this.resurrectionOptions({ from, to, promotion });
    if (!options) throw new Error('that move offers no resurrection');
    if (!options.homes.includes(home)) throw new Error(`no dead ${options.victimType} can return to ${home}`);

    const color = this.chess.turn();
    const type = options.victimType;
    const candidates = this.#eligibleEntries(color, type)
      .filter(({ entry }) => entry.homes.includes(home));
    const consumed = candidates[0];
    this.dead[color].splice(consumed.index, 1);

    const fenBefore = this.fen();
    this.chess.put({ type, color }, home);
    this.chess.move('--');
    // A resurrection is a material event, so the draw clock starts over just
    // as it would after a capture.
    this.chess.resetHalfMoves();
    // The returned piece is an ordinary piece from here on. Its home is the
    // square it came back to.
    this.origins.set(home, { home });

    const event = {
      kind: 'resurrect',
      ply: this.ply,
      color,
      piece: type,
      home,
      declined: { from, to, promotion: promotion || null, victimType: type, victimSquare: options.victimSquare },
      fenBefore,
      fenAfter: this.fen(),
    };
    this.log.push(event);
    this.ply++;
    this.#countPosition();
    return event;
  }

  resign(color) {
    this.pendingOffer = null;
    this.resignedBy = color;
    this.log.push({ kind: 'resign', color, ply: this.ply });
  }

  // The captured rows. byWhite = black pieces White has taken. A resurrection
  // never touches these directly, but the resurrector's own dead list shrank,
  // so the OPPONENT's row loses the returned piece.
  captured() {
    return {
      byWhite: this.dead.b.map((entry) => entry.type),
      byBlack: this.dead.w.map((entry) => entry.type),
    };
  }

  // The resurrectable dead for one side, for the UI: which types wait, and
  // which of their homes are open right now.
  graveyard(color) {
    return this.dead[color]
      .filter((entry) => entry.homes)
      .map((entry) => ({
        type: entry.type,
        homes: entry.homes.slice(),
        open: entry.homes.filter((home) => !this.chess.get(home)),
      }));
  }

  resurrectionsUsed(color) {
    return this.log.filter((entry) => entry.kind === 'resurrect' && entry.color === color).length;
  }

  serializedActions() {
    return this.log.flatMap((entry) => {
      if (entry.kind === 'move') return [{ kind: 'move', uci: entry.uci }];
      if (entry.kind === 'resurrect') {
        const { from, to, promotion } = entry.declined;
        return [{ kind: 'resurrect', uci: from + to + (promotion || ''), home: entry.home }];
      }
      if (entry.kind === 'resign') return [{ kind: 'resign', color: entry.color }];
      return [];
    });
  }
}

export function replayMatch(seed, actions) {
  const match = new ExchangeMatch(seed);
  for (const action of actions) {
    if (action?.kind === 'move' && typeof action.uci === 'string') {
      match.applyMove({
        from: action.uci.slice(0, 2),
        to: action.uci.slice(2, 4),
        promotion: action.uci[4],
      });
    } else if (action?.kind === 'resurrect' && typeof action.uci === 'string') {
      match.resurrect({
        from: action.uci.slice(0, 2),
        to: action.uci.slice(2, 4),
        promotion: action.uci[4],
        home: action.home,
      });
    } else if (action?.kind === 'resign') {
      match.resign(action.color);
    } else {
      throw new Error('invalid replay action');
    }
  }
  return match;
}

// Deterministic helper for tests and recovery paths: a seeded coin for
// whether a random game takes an offered resurrection.
export function seededCoin(seed, key) {
  return makeRng(seedFromString(`${seed}#${key}`)).next();
}
