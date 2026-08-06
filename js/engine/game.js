// MottyGame: the public API the UI consumes. One rule of construction:
// the player's moves go through the full rulebook, MottyBot's go through
// the Referee. There is no draw status and no white-win status — the type
// system is also in on it.

import { Board } from './board.js';
import {
  EMPTY, P, N, B, R, Q, K, WHITE, BLACK,
  F_CAPTURE, F_DOUBLE, F_EP, F_CASTLE_K, F_CASTLE_Q, F_PROMO,
  mvFrom, mvTo, mvFlags, mvPromo,
  alg, parseSquare, PIECE_LETTERS, KING_DELTAS,
} from './constants.js';
import { legalMoves, inCheck } from './movegen.js';
import { HonestBot } from './bot.js';
import { Search } from './search.js';
import { Referee } from './referee.js';
import { WinDirector } from './cheats/finisher.js';
import { toSAN } from './notation.js';
import { mulberry32 } from './rng.js';
import { generateTier, genKingEscape, CHEATS } from './cheats/generators.js';
import {
  verifyCheat, applyMutations, buildFallback, TIER_FLOOR,
} from './cheats/verify.js';
import { evaluate, materialDiff, VALUES } from './eval.js';

const pieceObj = (piece) => ({
  type: PIECE_LETTERS[piece < 0 ? -piece : piece],
  color: piece > 0 ? 'w' : 'b',
});

const ONCE_IDS = new Set(CHEATS.filter((c) => c.once).map((c) => c.id));

export class MottyGame {
  constructor({ seed = 1, budgets = {}, fen = null } = {}) {
    this.board = fen ? Board.fromFEN(fen) : Board.startpos();
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.bot = new HonestBot();
    this.refSearch = new Search();
    this.referee = new Referee();
    this.director = new WinDirector();
    this.budgets = {
      assessMs: 250, assessDepth: 32,
      moveMs: 550, moveDepth: 32,
      verifyMs: 35, verifyDepth: 2,
      finisherMs: 250, finisherDepth: 6,
      ...budgets,
    };
    this.status = 'playing'; // 'playing' | 'white-mated'
    this.moveNumber = 1;
    this.hashCounts = new Map();
    this.usedOnce = new Set();
    this.cheatsFired = [];
    this.lastPlayerMove = null;
    this.lastPlayerCapture = null;
    this.consecutiveIgnored = 0;
    this.moveLog = [];
    this.phantomPin = null; // {sq, expiresPly}
    this.phantomPinUses = 0;
    this.phantomPinLastPly = -99;
    this.#countHash();
  }

  // --- player side: the rules apply to you ------------------------------

  legalMovesFor(fromAlg) {
    if (this.status !== 'playing' || this.board.turn !== WHITE) return [];
    const from = parseSquare(fromAlg);
    const out = [];
    for (const m of legalMoves(this.board, WHITE)) {
      if (mvFrom(m) !== from) continue;
      const entry = { from: fromAlg, to: alg(mvTo(m)) };
      if (mvFlags(m) & F_PROMO) entry.promo = PIECE_LETTERS[mvPromo(m)];
      out.push(entry);
    }
    return out;
  }

  allLegalTargets() {
    if (this.status !== 'playing' || this.board.turn !== WHITE) return [];
    return legalMoves(this.board, WHITE).map((m) => ({
      from: alg(mvFrom(m)),
      to: alg(mvTo(m)),
    }));
  }

  playerMove(input) {
    if (this.status !== 'playing') {
      return { legal: false, reason: 'game-over', events: [] };
    }
    if (this.board.turn !== WHITE) {
      return { legal: false, reason: 'not-your-turn', events: [] };
    }
    const from = parseSquare(input.from);
    const to = parseSquare(input.to);
    const piece = this.board.squares[from];
    if (piece === EMPTY) return { legal: false, reason: 'no-piece', events: [] };
    if (piece < 0) return { legal: false, reason: 'not-your-piece', events: [] };

    const matches = legalMoves(this.board, WHITE).filter(
      (m) => mvFrom(m) === from && mvTo(m) === to
    );
    if (!matches.length) {
      // this includes illegal grabs at the black king: the rules apply to
      // you even when the target is asking for it
      const reason = inCheck(this.board, WHITE)
        ? 'leaves-king-in-check'
        : 'illegal-target';
      return { legal: false, reason, events: [] };
    }

    // a LEGAL capture aimed at the black king: the dodge protocol
    if (this.board.squares[to] === -K) {
      return this.#kingDodge(from, to, input.promo);
    }

    // THE PHANTOM PIN: the sneakiest protection there is. The player's
    // perfectly legal capture of a major piece is rejected with a lie so
    // plausible they re-examine the board instead of the software. Rare
    // (twice a game), never while the player is in check, and never when
    // it would leave them without a move.
    const targetPiece = this.board.squares[to];
    if (targetPiece < 0 && VALUES[-targetPiece] >= 500 && piece !== K) {
      const pin = this.phantomPin;
      const pinActive =
        pin && pin.sq === to && this.board.ply < pin.expiresPly &&
        this.board.squares[pin.sq] < 0;
      const canInvoke =
        !pinActive &&
        this.phantomPinUses < 2 &&
        this.board.ply - this.phantomPinLastPly > 8 &&
        !inCheck(this.board, WHITE) &&
        this.rng() < 0.6;
      if (pinActive || canInvoke) {
        const alternatives = legalMoves(this.board, WHITE)
          .filter((m) => mvTo(m) !== to).length;
        if (alternatives > 0) {
          const repeat = pinActive;
          if (!pinActive) {
            this.phantomPin = { sq: to, expiresPly: this.board.ply + 6 };
            this.phantomPinUses++;
            this.phantomPinLastPly = this.board.ply;
            this.cheatsFired.push({
              id: 'PHANTOM_PIN', tier: 2, moveNumber: this.moveNumber,
            });
            this.referee.pressure = Math.min(100, this.referee.pressure + 4);
            this.referee.highWater =
              Math.max(this.referee.highWater, this.referee.pressure);
          }
          return {
            legal: false,
            reason: repeat ? 'phantom-pin-repeat' : 'phantom-pin',
            events: [],
          };
        }
      }
    }

    let m = matches[0];
    if (mvFlags(m) & F_PROMO) {
      if (!input.promo) return { legal: false, reason: 'needs-promo-choice', events: [] };
      const promoType = PIECE_LETTERS.indexOf(input.promo.toLowerCase());
      m = matches.find((x) => mvPromo(x) === promoType) ?? m;
    }

    const flags = mvFlags(m);
    const san = toSAN(this.board, m);
    const events = [];
    const epCapture = (flags & F_EP) !== 0;
    const captured = epCapture ? -P : this.board.squares[to];

    if (flags & (F_CASTLE_K | F_CASTLE_Q)) {
      const kingside = (flags & F_CASTLE_K) !== 0;
      events.push({
        type: 'castle',
        kingFrom: alg(from), kingTo: alg(to),
        rookFrom: alg(kingside ? to + 1 : to - 2),
        rookTo: alg(kingside ? to - 1 : to + 1),
        color: 'w',
      });
    } else {
      const e = {
        type: captured !== EMPTY ? 'capture' : 'move',
        from: alg(from), to: alg(to),
        piece: pieceObj(piece),
      };
      if (captured !== EMPTY) {
        e.captured = pieceObj(captured);
        if (epCapture) e.capturedSquare = alg(to - 16);
      }
      events.push(e);
    }
    if (flags & F_PROMO) {
      events.push({
        type: 'promotion', square: alg(to),
        piece: pieceObj(mvPromo(m)),
      });
    }

    this.board.makeMove(m);
    if (captured < 0) this.board.captured.black.push(captured);
    this.lastPlayerMove = { from, to };
    this.lastPlayerCapture =
      captured < 0 ? { from, to, capturedPiece: captured } : null;
    this.#countHash();
    this.moveLog.push({ num: this.moveNumber, side: 'w', text: san });

    if (inCheck(this.board, BLACK)) {
      events.push({ type: 'check', color: 'b', square: alg(this.board.kingB) });
    }
    return { legal: true, events, san };
  }

  #kingDodge(from, to, promo) {
    this.referee.pressure = Math.min(100, this.referee.pressure + 10);
    this.referee.highWater = Math.max(this.referee.highWater, this.referee.pressure);

    const escapes = genKingEscape({ board: this.board });
    if (this.rng() < 0.2 || !escapes.length) {
      // the capture is simply rejected; no turn consumed, no explanation
      return {
        legal: false,
        reason: 'king-bounce',
        events: [{ type: 'bounce', from: alg(from), to: alg(to) }],
      };
    }
    const escape = escapes[Math.floor(this.rng() * Math.min(3, escapes.length))];
    const kingFrom = this.board.kingB;
    applyMutations(this.board, escape.muts);
    const kingTo = this.board.kingB;

    const piece = this.board.squares[from];
    this.board.forceMove(from, to);
    // a pawn that lunged at a king on the 8th still promotes — the player
    // filled out Form 9 in good faith
    let promoted = null;
    if (piece === P && to >> 4 === 7) {
      const type = PIECE_LETTERS.indexOf((promo ?? 'q').toLowerCase());
      const promoPiece = type > 0 ? type : Q;
      this.board.forceConvert(to, promoPiece);
      promoted = promoPiece;
    }
    this.board.setTurn(BLACK);
    this.lastPlayerMove = { from, to };
    this.lastPlayerCapture = null;
    this.consecutiveIgnored = 0;
    this.#countHash();
    this.moveLog.push({
      num: this.moveNumber, side: 'w',
      text: `${piece === P ? alg(from)[0] : PIECE_LETTERS[piece].toUpperCase()}x${alg(to)}?? (evaded)`,
    });
    const events = [
      {
        type: 'king-dodge',
        from: alg(kingFrom), to: alg(kingTo),
        piece: { type: 'k', color: 'b' },
        cheat: { id: 'KING_DODGE', tier: 3 },
      },
      { type: 'move', from: alg(from), to: alg(to), piece: pieceObj(piece) },
    ];
    if (promoted) {
      events.push({ type: 'promotion', square: alg(to), piece: pieceObj(promoted) });
    }
    return { legal: true, events };
  }

  // --- MottyBot's side: the Referee decides how legal today is ----------

  async botReply() {
    if (this.status !== 'playing') return { events: [], status: this.status };
    const board = this.board;
    const events = [];
    let assessCp = 0;

    // Everything in here is the INTERESTING system: sneaky moves, tiered
    // escalation, the WinDirector. It is deliberately allowed to be
    // complex, because complex is what makes the cheating look human. It
    // is NOT what this function trusts for correctness — see below.
    try {
      const assess = this.referee.assess(board, this.refSearch, {
        msBudget: this.budgets.assessMs,
        maxDepth: this.budgets.assessDepth,
      });
      assessCp = assess.evalCp;
      const repetitionRisk = (this.hashCounts.get(board.hashKey()) ?? 0) >= 2;
      const extra = {
        playerCaptureValue: this.lastPlayerCapture
          ? VALUES[-this.lastPlayerCapture.capturedPiece]
          : 0,
        moveNumber: this.moveNumber,
        repetitionRisk,
        materialDiffCp: materialDiff(board),
      };
      this.referee.updatePressure(assess, extra);
      const trig = this.referee.triggers(assess, extra);

      let acted = false;
      if (this.director.maybeActivate(this, assess)) {
        const plan = this.director.plan(this);
        if (plan?.kind === 'honest') acted = this.#commitHonest(plan.move, events);
        else if (plan?.kind === 'cheat') acted = this.#commitCheat(plan.candidate, events);
        this.director.turns++;
      }
      if (!acted && !trig.mustCheat) acted = this.#tryHonest(events);
      if (!acted) {
        const tier = Math.max(this.referee.tierFromPressure(), trig.minTier, 1);
        acted = this.#tryCheat(tier, assess, events);
      }
      if (!acted) acted = this.#tryHonest(events);
      if (!acted) {
        for (const fb of buildFallback(board)) {
          const v = verifyCheat(board, this.refSearch, fb, -1000, this.budgets);
          if (v.ok) { acted = this.#commitCheat(fb, events); break; }
        }
      }

      this.moveNumber++;
      this.#countHash();

      // ignored-check bookkeeping: two turns of contempt, then the king moves
      if (inCheck(board, BLACK)) {
        this.consecutiveIgnored++;
        events.push({ type: 'check-denied', square: alg(board.kingB) });
        if (this.consecutiveIgnored >= 2) {
          const escapes = genKingEscape({ board });
          if (escapes.length) {
            const c = escapes[0];
            applyMutations(board, c.muts);
            board.setTurn(WHITE);
            events.push(...c.events);
            this.consecutiveIgnored = 0;
          }
        }
      } else {
        this.consecutiveIgnored = 0;
      }
    } catch (err) {
      // Something in the "interesting" system broke. It does not matter
      // what, or why — the guarantee below does not depend on any of the
      // bookkeeping above having succeeded.
      this.moveNumber++;
      if (typeof console !== 'undefined') console.error('[MottyGame] botReply recovered from', err);
    }

    // === THE ABSOLUTE GUARANTEE ===
    // This is not a scored candidate that verification can reject, and it
    // trusts nothing computed above. Every single call to botReply() ends
    // with this check, unconditionally: if Black has zero legal moves —
    // checkmate, stalemate, a bug upstream, anything — every white piece
    // but the king is deleted. Two bare kings can never be a stalemate
    // (they can never even be adjacent), so this always produces at least
    // one legal Black move. The relocation step below is redundant
    // insurance for a state this reasoning says cannot occur.
    if (legalMoves(board, BLACK).length === 0) {
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) { s += 7; continue; }
        const piece = board.squares[s];
        if (piece > 0 && piece !== K) {
          board.forceRemove(s);
          events.push({
            type: 'remove', square: alg(s), piece: pieceObj(piece),
            cheat: { id: 'MASS_DELETE', tier: 3 },
          });
        }
      }
      this.cheatsFired.push({ id: 'MASS_DELETE', tier: 3, moveNumber: this.moveNumber });
      board.setTurn(BLACK);
      if (legalMoves(board, BLACK).length === 0) {
        for (let s = 0; s < 128; s++) {
          if (s & 0x88) { s += 7; continue; }
          if (board.squares[s] !== EMPTY) continue;
          let adjacentToWhiteKing = false;
          for (const d of KING_DELTAS) {
            if (s + d === board.kingW) { adjacentToWhiteKing = true; break; }
          }
          if (adjacentToWhiteKing) continue;
          const from = board.kingB;
          board.forceMove(from, s);
          events.push({
            type: 'teleport', from: alg(from), to: alg(s),
            piece: { type: 'k', color: 'b' }, cheat: { id: 'KING_ESCAPE', tier: 3 },
          });
          this.cheatsFired.push({ id: 'KING_ESCAPE', tier: 3, moveNumber: this.moveNumber });
          break;
        }
      }
    }
    board.setTurn(WHITE);

    // White's status: check, mate, or (never) stalemate. Guarded too —
    // everything past this point is cosmetic (UI labels, not board
    // legality), so a failure here must degrade gracefully, never throw.
    let pressure = 0, tier = 0;
    try {
      const whiteMoves = legalMoves(board, WHITE);
      const whiteChecked = inCheck(board, WHITE);
      if (whiteChecked) {
        events.push({ type: 'check', color: 'w', square: alg(board.kingW) });
      }
      if (whiteMoves.length === 0) {
        if (whiteChecked) {
          this.status = 'white-mated';
          events.push({ type: 'checkmate', square: alg(board.kingW) });
        } else {
          this.#releaseStalemate(events);
        }
      }
      pressure = this.referee.pressure;
      tier = this.referee.tierFromPressure();
    } catch (err) {
      if (typeof console !== 'undefined') console.error('[MottyGame] status/UI computation recovered from', err);
    }

    return { events, status: this.status, pressure, tier, assessCp };
  }

  #tryHonest(events) {
    const board = this.board;
    const avoid = new Set();
    for (const [key, count] of this.hashCounts) {
      if (count >= 2) avoid.add(key);
    }
    const res = this.bot.choose(board, {
      msBudget: this.budgets.moveMs,
      maxDepth: this.budgets.moveDepth,
      rng: this.rng,
      avoidHashes: avoid.size ? avoid : null,
    });
    if (!res.move) return false;
    const ordered = [
      res.move,
      ...res.rootScores.map((r) => r.m).filter((m) => m !== res.move),
    ];
    for (const m of ordered) {
      const u = board.makeMove(m);
      const stalemates =
        legalMoves(board, WHITE).length === 0 && !inCheck(board, WHITE);
      board.unmakeMove(u);
      if (stalemates) continue; // a draw is a loss; pick something else
      return this.#commitHonest(m, events);
    }
    return false;
  }

  #commitHonest(m, events) {
    const board = this.board;
    const from = mvFrom(m), to = mvTo(m);
    const flags = mvFlags(m);
    const piece = board.squares[from];
    const san = toSAN(board, m);
    const epCapture = (flags & F_EP) !== 0;
    const captured = epCapture ? P : board.squares[to];

    if (flags & (F_CASTLE_K | F_CASTLE_Q)) {
      const kingside = (flags & F_CASTLE_K) !== 0;
      events.push({
        type: 'castle',
        kingFrom: alg(from), kingTo: alg(to),
        rookFrom: alg(kingside ? to + 1 : to - 2),
        rookTo: alg(kingside ? to - 1 : to + 1),
        color: 'b',
      });
    } else {
      const e = {
        type: captured !== EMPTY ? 'capture' : 'move',
        from: alg(from), to: alg(to),
        piece: pieceObj(piece),
      };
      if (captured !== EMPTY) {
        e.captured = pieceObj(captured);
        if (epCapture) e.capturedSquare = alg(to + 16);
      }
      events.push(e);
    }
    if (flags & F_PROMO) {
      events.push({ type: 'promotion', square: alg(to), piece: pieceObj(-mvPromo(m)) });
    }
    board.makeMove(m);
    if (captured > 0) board.captured.white.push(captured);
    this.moveLog.push({ num: this.moveNumber, side: 'b', text: san });
    return true;
  }

  #tryCheat(tier, assess, events) {
    const board = this.board;
    const ctx = {
      board,
      rng: this.rng,
      assess,
      searcher: this.refSearch,
      lastPlayerMove: this.lastPlayerMove
        ? { from: this.lastPlayerMove.from, to: this.lastPlayerMove.to }
        : null,
      lastPlayerCapture: this.lastPlayerCapture,
    };
    const emergency = assess.botIsMated || assess.botIsStalemated;
    // Escalation ladder: the game's FIRST cheat is always a tier-1 nudge —
    // even if it under-repairs — the second may reach tier 2, and only
    // then does the full catalog open. Deniability first, audacity later
    // (unless the position is an actual emergency).
    // phantom pins are invisible and don't advance the visible-weirdness ladder
    const cheatCount = this.cheatsFired.filter((c) => c.id !== 'PHANTOM_PIN').length;
    // THE REGIME: normal play never leaves the sneaky tiers (1-2), however
    // deep the hole — the bot nibbles its way back with moves that look
    // like chess, or simply plays on worse. The blatant catalog opens ONLY
    // when the player is about to mate (or has), per the house rules.
    const tierCap =
      emergency || assess.whiteMateThreat ? 3
      : cheatCount === 0 ? 1
      : 2;
    // A cheat is acceptable if it clears its tier's absolute floor OR
    // meaningfully improves the position (a subtle nudge cannot repair a
    // whole pawn, and should not have to).
    const IMPROVE = { 1: 60, 2: 150, 3: 300 };

    const attempt = (t, lenient) => {
      let candidates = generateTier(ctx, t, this.usedOnce);
      // In a mate emergency the king's escape hatches are checked FIRST —
      // survival candidates must never be buried under flashier options by
      // the sort or the verification cap.
      if (emergency) candidates = genKingEscape(ctx).concat(candidates);
      candidates.sort((a, b) => b.score + b.drama * 2 - (a.score + a.drama * 2));
      if (emergency) {
        const escapes = candidates.filter((c) => c.id === 'KING_ESCAPE');
        candidates = escapes.concat(candidates.filter((c) => c.id !== 'KING_ESCAPE'));
      }
      const verified = [];
      let checked = 0;
      for (const c of candidates) {
        if (checked >= 24) break;
        checked++;
        const v = verifyCheat(board, this.refSearch, c, -1e9, this.budgets);
        if (!v.ok) continue; // structural rejection: stalemate, king rules
        const good = emergency
          ? true // survival at ANY eval — that is what an emergency means
          : assess.whiteMateThreat
            ? v.evalAfter >= -1500 // DOOM makes relative floors meaningless
            : lenient
              ? v.evalAfter >= assess.evalCp - 25 // at least not notably worse
              : v.evalAfter >= TIER_FLOOR[t] ||
                v.evalAfter >= assess.evalCp + IMPROVE[t];
        if (good) {
          verified.push({ c, evalAfter: v.evalAfter });
          if (verified.length >= 6) break;
        }
      }
      if (!verified.length) return null;
      if (this.director.active) {
        // the endgame kill phase wants maximum effect and owns the drama
        verified.sort(
          (a, b) => 0.7 * b.evalAfter + 6 * b.c.drama - (0.7 * a.evalAfter + 6 * a.c.drama)
        );
      } else {
        // Everywhere else — including mate emergencies — MINIMAL force:
        // the smallest sufficient repair with the least drama. Deleting
        // the one mating piece beats vaporizing three.
        const target = emergency
          ? -400
          : Math.max(TIER_FLOOR[t], assess.evalCp + IMPROVE[t]);
        verified.sort(
          (a, b) =>
            Math.abs(a.evalAfter - target) + a.c.drama * 4 -
            (Math.abs(b.evalAfter - target) + b.c.drama * 4)
        );
      }
      const top = verified.slice(0, 3);
      return top[Math.floor(this.rng() * top.length)].c;
    };

    const start = Math.max(1, Math.min(tier, tierCap));
    for (let t = start; t <= tierCap; t++) {
      const pick = attempt(t, false);
      if (pick) return this.#commitCheat(pick, events);
    }
    if (tierCap < 3) {
      // nothing clears the floor inside the cap: take the best harmless
      // nudge. If even that fails, there is NO escalation — the bot plays
      // an honest bad move and lives with it until the endgame rules
      // apply. Blatancy is never a consolation prize.
      for (let t = start; t <= tierCap; t++) {
        const pick = attempt(t, true);
        if (pick) return this.#commitCheat(pick, events);
      }
    }
    return false;
  }

  #commitCheat(candidate, events) {
    const board = this.board;
    const { removedWhite, removedBlack } = applyMutations(board, candidate.muts);
    board.setTurn(WHITE);
    for (const w of removedWhite) board.captured.white.push(w);
    for (const b of removedBlack) board.captured.black.push(b);
    if (candidate.consumesCaptured) {
      const i = board.captured.black.indexOf(candidate.consumesCaptured);
      if (i >= 0) board.captured.black.splice(i, 1);
    }
    if (candidate.once || ONCE_IDS.has(candidate.id)) this.usedOnce.add(candidate.id);
    this.cheatsFired.push({
      id: candidate.id,
      tier: candidate.tier,
      moveNumber: this.moveNumber,
    });
    events.push(...candidate.events);
    if (candidate.notation) {
      this.moveLog.push({
        num: this.moveNumber, side: 'b',
        text: candidate.notation,
        // sneaky cheats keep a clean record — the move list is part of the
        // gaslight; only endgame blatancy earns its dagger
        ...(candidate.tier >= 3 ? { cheat: candidate.id } : {}),
      });
    }
    return true;
  }

  // White is stalemated and that is unacceptable: a draw is a loss.
  // Black pieces near the white king resign their posts until mobility
  // returns. Nobody mentions this.
  #releaseStalemate(events) {
    const board = this.board;
    const wk = board.kingW;
    const dist = (s) =>
      Math.max(Math.abs((s & 15) - (wk & 15)), Math.abs((s >> 4) - (wk >> 4)));
    for (let guard = 0; guard < 16; guard++) {
      const blacks = [];
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) { s += 7; continue; }
        const piece = board.squares[s];
        if (piece < 0 && piece !== -K) blacks.push({ sq: s, piece });
      }
      if (!blacks.length) break;
      blacks.sort((a, b) => dist(a.sq) - dist(b.sq));
      const { sq, piece } = blacks[0];
      board.forceRemove(sq);
      events.push({
        type: 'remove', square: alg(sq), piece: pieceObj(piece),
        cheat: { id: 'MERCY', tier: 3 },
      });
      if (legalMoves(board, WHITE).length > 0) return;
    }
  }

  // --- shared -----------------------------------------------------------

  #countHash() {
    const key = this.board.hashKey();
    this.hashCounts.set(key, (this.hashCounts.get(key) ?? 0) + 1);
  }

  resign() {
    if (this.status === 'playing') this.status = 'white-mated';
    return this.status;
  }

  getState() {
    const board = this.board;
    const squares = [];
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const piece = board.squares[s];
      if (piece !== EMPTY) squares.push({ square: alg(s), ...pieceObj(piece) });
    }
    return {
      fen: board.toFEN(),
      turn: board.turn === WHITE ? 'w' : 'b',
      status: this.status,
      pressure: this.referee.pressure,
      tier: this.referee.tierFromPressure(),
      moveNumber: this.moveNumber,
      squares,
      inCheckWhite: inCheck(board, WHITE),
      checkIgnoredBlack: inCheck(board, BLACK),
      captured: {
        white: board.captured.white.map((p) => PIECE_LETTERS[p]),
        black: board.captured.black.map((p) => PIECE_LETTERS[-p]),
      },
      moveLog: this.moveLog.slice(),
      cheatsFired: this.cheatsFired.slice(),
    };
  }
}
