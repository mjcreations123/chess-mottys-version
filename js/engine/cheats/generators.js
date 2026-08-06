// Cheat candidate generators. Targeted, never random: a teleport hunts the
// player's best piece, a spawn hunts forks, a delete picks the piece that
// hurts most. Every candidate is later re-scored by verify.js with a real
// search — these only propose.
//
// Candidate shape:
// {
//   id, tier, drama,          // drama 0..100, comedy weight
//   score,                    // static pre-verify estimate (cp-ish)
//   muts: [{op:'move'|'set'|'remove'|'convert'|'swap', ...0x88 squares}],
//   events: [...],            // UI event objects (alg squares)
//   notation: string|null,    // move-list entry; null = silently omitted
//   once?: true,              // once per game
//   allowsKingEnPrise?: true, // IGNORE_CHECK family only
//   consumesCaptured?: pieceCode, // pops from board.captured.black
// }

import {
  EMPTY, P, N, B, R, Q, K, WHITE, BLACK,
  KNIGHT_DELTAS, KING_DELTAS, BISHOP_DIRS, ROOK_DIRS, QUEEN_DIRS,
  F_PROMO, F_CASTLE_K, F_CASTLE_Q, F_CAPTURE,
  mvFrom, mvTo, mvFlags, alg, PIECE_LETTERS,
  SQ_E8, SQ_H8, SQ_A8, CASTLE_BK, CASTLE_BQ,
} from '../constants.js';
import { isAttacked, inCheck, pseudoMoves, legalMoves } from '../movegen.js';
import { VALUES } from '../eval.js';

const WIDE_L = [49, 47, 19, 13, -13, -19, -47, -49]; // the (3,1) "regulation L"

const pieceObj = (piece) => ({
  type: PIECE_LETTERS[piece < 0 ? -piece : piece],
  color: piece > 0 ? 'w' : 'b',
});
const up = (piece) => PIECE_LETTERS[piece < 0 ? -piece : piece].toUpperCase();

function* onboard() {
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    yield s;
  }
}

function piecesOf(board, color) {
  const out = [];
  for (const s of onboard()) {
    const p = board.squares[s];
    if (p !== EMPTY && (p > 0) === (color > 0)) out.push({ sq: s, piece: p });
  }
  return out;
}

// Would `type` (of `color`) standing on `from` attack `to`, with `ignoreSq`
// treated as empty (a moving piece's origin)?
export function attacksFrom(board, from, to, type, color, ignoreSq = -1) {
  const diff = to - from;
  if (type === P) {
    return color > 0 ? diff === 15 || diff === 17 : diff === -15 || diff === -17;
  }
  if (type === N) return KNIGHT_DELTAS.includes(diff);
  if (type === K) return KING_DELTAS.includes(diff);
  const dirs = type === B ? BISHOP_DIRS : type === R ? ROOK_DIRS : QUEEN_DIRS;
  for (const d of dirs) {
    let t = from + d;
    while (!(t & 0x88)) {
      if (t === to) return true;
      if (t !== ignoreSq && board.squares[t] !== EMPTY) break;
      t += d;
    }
  }
  return false;
}

function cheapestWhiteAttacker(board, s, ignoreSq = -1) {
  let min = Infinity;
  const sqs = board.squares;
  let t = s - 15;
  if (!(t & 0x88) && sqs[t] === P) min = 100;
  t = s - 17;
  if (!(t & 0x88) && sqs[t] === P) min = 100;
  if (min > 320) {
    for (const d of KNIGHT_DELTAS) {
      t = s + d;
      if (!(t & 0x88) && sqs[t] === N) { min = 320; break; }
    }
  }
  for (const d of QUEEN_DIRS) {
    t = s + d;
    let dist = 1;
    while (!(t & 0x88)) {
      const p = sqs[t];
      if (t !== ignoreSq && p !== EMPTY) {
        if (p > 0) {
          const diag = d === 17 || d === 15 || d === -15 || d === -17;
          if (p === Q) min = Math.min(min, 900);
          else if (diag && p === B) min = Math.min(min, 330);
          else if (!diag && p === R) min = Math.min(min, 500);
          else if (dist === 1 && p === K) min = Math.min(min, 20000);
        }
        break;
      }
      t += d;
      dist++;
    }
  }
  return min;
}

// Static "will this black piece survive standing here" filter. The verify
// search is the real judge; this just prunes hopeless candidates.
function staticSafe(board, s, pieceValue, ignoreSq = -1) {
  const attacker = cheapestWhiteAttacker(board, s, ignoreSq);
  if (attacker === Infinity) return true;
  if (attacker === 20000) return isAttacked(board, s, BLACK); // king needs the piece defended
  const defended = isAttacked(board, s, BLACK);
  return defended && attacker >= pieceValue - 50;
}

// Sum of white material a piece of `type` would attack from `s`, plus check.
function menace(board, s, type, ignoreSq = -1) {
  let total = 0, fork = 0, check = false;
  for (const t of onboard()) {
    const p = board.squares[t];
    if (p <= 0) continue;
    if (!attacksFrom(board, s, t, type, BLACK, ignoreSq)) continue;
    if (p === K) { check = true; continue; }
    total += VALUES[p];
    if (VALUES[p] >= 300) fork++;
  }
  return { total, fork, check };
}

function moveEvent(type, from, to, piece, captured, cheat, path = null) {
  const e = { type, from: alg(from), to: alg(to), piece: pieceObj(piece) };
  if (captured) e.captured = pieceObj(captured);
  if (path) e.path = path.map(alg);
  if (cheat) e.cheat = cheat;
  return e;
}

const meta = (id, tier) => ({ id, tier });

// --- Tier 1: plausible deniability -------------------------------------

function genLongPawn({ board }) {
  const out = [];
  for (const { sq } of piecesOf(board, BLACK)) {
    if (board.squares[sq] !== -P) continue;
    if (sq >> 4 === 6) {
      // three squares off the home rank: "you are thinking of the old rules"
      const path = [sq - 16, sq - 32, sq - 48];
      if (path.some((t) => board.squares[t] !== EMPTY)) continue;
      const to = sq - 48;
      out.push({
        id: 'LONG_PAWN', tier: 1, drama: 15,
        score: 40 + menace(board, to, P).total / 4,
        muts: [{ op: 'move', from: sq, to }],
        events: [moveEvent('cheat-move', sq, to, -P, null, meta('LONG_PAWN', 1), [sq, sq - 16, sq - 32, to])],
        notation: alg(to),
      });
    } else if (sq >> 4 >= 3 && sq >> 4 <= 5) {
      // a mid-board double push: "that pawn had not moved yet. Check your
      // notes. You have no notes."
      const one = sq - 16, two = sq - 32;
      if (board.squares[one] !== EMPTY || board.squares[two] !== EMPTY) continue;
      const m = menace(board, two, P);
      if (m.total < 300 && !m.check) continue;
      out.push({
        id: 'LONG_PAWN', tier: 1, drama: 12,
        score: 35 + m.total / 4,
        muts: [{ op: 'move', from: sq, to: two }],
        events: [moveEvent('cheat-move', sq, two, -P, null, meta('LONG_PAWN', 1), [sq, one, two])],
        notation: alg(two),
      });
    }
  }
  return out;
}

function genWideKnight({ board }) {
  const out = [];
  for (const { sq } of piecesOf(board, BLACK)) {
    if (board.squares[sq] !== -N) continue;
    for (const d of WIDE_L) {
      const to = sq + d;
      if (to & 0x88) continue;
      const target = board.squares[to];
      if (target > 0 && target !== K) {
        const m = menace(board, to, N, sq);
        out.push({
          id: 'WIDE_KNIGHT', tier: 1, drama: 20,
          score: VALUES[target] + m.total / 4 + (staticSafe(board, to, 320, sq) ? 40 : -80),
          muts: [{ op: 'move', from: sq, to }],
          events: [moveEvent('cheat-move', sq, to, -N, target, meta('WIDE_KNIGHT', 1))],
          notation: `Nx${alg(to)}`,
        });
      } else if (target === EMPTY) {
        const m = menace(board, to, N, sq);
        if (m.total < 300 && !m.check) continue;
        out.push({
          id: 'WIDE_KNIGHT', tier: 1, drama: 20,
          score: m.total / 3 + (m.check ? 60 : 0) + (staticSafe(board, to, 320, sq) ? 40 : -80),
          muts: [{ op: 'move', from: sq, to }],
          events: [moveEvent('cheat-move', sq, to, -N, null, meta('WIDE_KNIGHT', 1))],
          notation: `N${alg(to)}`,
        });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

function genSliderPhase({ board }) {
  // A slider glides through exactly one blocker. Quietly. Confidently.
  const out = [];
  for (const { sq, piece } of piecesOf(board, BLACK)) {
    const type = -piece;
    if (type !== B && type !== R && type !== Q) continue;
    const dirs = type === B ? BISHOP_DIRS : type === R ? ROOK_DIRS : QUEEN_DIRS;
    for (const d of dirs) {
      let t = sq + d;
      const path = [sq];
      while (!(t & 0x88) && board.squares[t] === EMPTY) { path.push(t); t += d; }
      if (t & 0x88) continue;
      const blocker = t; // first piece on the ray — glide through it
      path.push(blocker);
      let land = blocker + d;
      while (!(land & 0x88)) {
        const target = board.squares[land];
        if (target === EMPTY || (target > 0 && target !== K)) {
          const m = menace(board, land, type, sq);
          const capture = target > 0 ? VALUES[target] : 0;
          if (capture === 0 && m.total < 300 && !m.check) { if (target !== EMPTY) break; land += d; continue; }
          out.push({
            id: 'SLIDER_PHASE', tier: 1, drama: 18,
            score: capture + m.total / 4 + (m.check ? 50 : 0) +
              (staticSafe(board, land, VALUES[type], sq) ? 40 : -80),
            muts: [{ op: 'move', from: sq, to: land }],
            events: [moveEvent('cheat-move', sq, land, piece, target > 0 ? target : null,
              meta('SLIDER_PHASE', 1), [...path, land])],
            notation: `${up(type)}${capture ? 'x' : ''}${alg(land)}`,
          });
        }
        if (target !== EMPTY) break;
        land += d;
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 10);
}

function genBishopDrift({ board }) {
  // Diagonal slide, then one file sideways: lands on the wrong color square.
  const out = [];
  for (const { sq, piece } of piecesOf(board, BLACK)) {
    if (piece !== -B) continue;
    for (const d of BISHOP_DIRS) {
      let t = sq + d;
      const path = [sq];
      while (!(t & 0x88) && board.squares[t] === EMPTY) {
        path.push(t);
        for (const side of [1, -1]) {
          const land = t + side;
          if (land & 0x88) continue;
          const target = board.squares[land];
          if (target < 0 || target === K) continue;
          const m = menace(board, land, B, sq);
          const capture = target > 0 ? VALUES[target] : 0;
          if (capture === 0 && m.total < 300 && !m.check) continue;
          out.push({
            id: 'BISHOP_DRIFT', tier: 1, drama: 22,
            score: capture + m.total / 4 + (m.check ? 50 : 0) +
              (staticSafe(board, land, 330, sq) ? 40 : -80),
            muts: [{ op: 'move', from: sq, to: land }],
            events: [moveEvent('cheat-move', sq, land, piece, target > 0 ? target : null,
              meta('BISHOP_DRIFT', 1), [...path, land])],
            notation: `B${capture ? 'x' : ''}${alg(land)}`,
          });
        }
        t += d;
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 6);
}

function genSneakyCastle({ board }) {
  // Castles through check, out of check, or with rights long gone — as long
  // as the geometry LOOKS like castling, MottyBot considers it castling.
  const out = [];
  const sqs = board.squares;
  if (sqs[SQ_E8] !== -K) return out;
  const legalNow = legalMoves(board, BLACK).some(
    (m) => mvFlags(m) & (F_CASTLE_K | F_CASTLE_Q)
  );
  if (legalNow) return out; // no cheat needed, no comedy earned
  if (sqs[SQ_H8] === -R && sqs[117] === EMPTY && sqs[118] === EMPTY) {
    out.push({
      id: 'SNEAKY_CASTLE', tier: 1, drama: 12,
      score: 70 + (inCheck(board, BLACK) ? 120 : 0),
      muts: [{ op: 'move', from: SQ_E8, to: 118 }, { op: 'move', from: SQ_H8, to: 117 }],
      events: [
        moveEvent('cheat-move', SQ_E8, 118, -K, null, meta('SNEAKY_CASTLE', 1)),
        moveEvent('cheat-move', SQ_H8, 117, -R, null, meta('SNEAKY_CASTLE', 1)),
      ],
      notation: 'O-O',
    });
  }
  if (sqs[SQ_A8] === -R && sqs[115] === EMPTY && sqs[114] === EMPTY && sqs[113] === EMPTY) {
    out.push({
      id: 'SNEAKY_CASTLE', tier: 1, drama: 12,
      score: 70 + (inCheck(board, BLACK) ? 120 : 0),
      muts: [{ op: 'move', from: SQ_E8, to: 114 }, { op: 'move', from: SQ_A8, to: 115 }],
      events: [
        moveEvent('cheat-move', SQ_E8, 114, -K, null, meta('SNEAKY_CASTLE', 1)),
        moveEvent('cheat-move', SQ_A8, 115, -R, null, meta('SNEAKY_CASTLE', 1)),
      ],
      notation: 'O-O-O',
    });
  }
  return out;
}

function genEpAbuse({ board }) {
  // "En passant" against a rook. It's French. Don't worry about it.
  const out = [];
  for (const { sq } of piecesOf(board, BLACK)) {
    if (board.squares[sq] !== -P) continue;
    for (const side of [1, -1]) {
      const beside = sq + side;
      if (beside & 0x88) continue;
      const victim = board.squares[beside];
      if (victim <= 0 || victim === K || victim === P) continue; // pawns would be legal-adjacent; boring
      if (VALUES[victim] > 330) continue; // majors vanishing "en passant" reads as theft, not French
      const to = beside - 16;
      if (to & 0x88 || board.squares[to] !== EMPTY) continue;
      out.push({
        id: 'EP_ABUSE', tier: 1, drama: 30,
        score: VALUES[victim] + (staticSafe(board, to, 100, sq) ? 30 : -40),
        muts: [{ op: 'move', from: sq, to }, { op: 'remove', sq: beside }],
        events: [
          moveEvent('cheat-move', sq, to, -P, null, meta('EP_ABUSE', 1)),
          { type: 'remove', square: alg(beside), piece: pieceObj(victim), cheat: meta('EP_ABUSE', 1) },
        ],
        notation: `${alg(sq)[0]}x${alg(beside)}`,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}

// --- Tier 2: creative interpretation -----------------------------------

function genRookSidestep({ board }) {
  const out = [];
  for (const { sq, piece } of piecesOf(board, BLACK)) {
    if (piece !== -R) continue;
    for (const d of BISHOP_DIRS) {
      const to = sq + d;
      if (to & 0x88) continue;
      const target = board.squares[to];
      if (target < 0 || target === K) continue;
      const m = menace(board, to, R, sq);
      const capture = target > 0 ? VALUES[target] : 0;
      if (capture === 0 && m.total < 300 && !m.check) continue;
      out.push({
        id: 'ROOK_SIDESTEP', tier: 2, drama: 20,
        score: capture + m.total / 4 + (m.check ? 50 : 0) +
          (staticSafe(board, to, 500, sq) ? 40 : -80),
        muts: [{ op: 'move', from: sq, to }],
        events: [moveEvent('cheat-move', sq, to, piece, target > 0 ? target : null, meta('ROOK_SIDESTEP', 2))],
        notation: `R${capture ? 'x' : ''}${alg(to)}`,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 6);
}

function genForwardBite({ board }) {
  const out = [];
  for (const { sq } of piecesOf(board, BLACK)) {
    if (board.squares[sq] !== -P) continue;
    const to = sq - 16;
    if (to & 0x88 || to >> 4 === 0) continue;
    const victim = board.squares[to];
    if (victim <= 0 || victim === K) continue;
    if (VALUES[victim] > 330) continue; // a pawn eating a queen head-on is a headline
    out.push({
      id: 'FORWARD_BITE', tier: 2, drama: 35,
      score: VALUES[victim] + (staticSafe(board, to, 100, sq) ? 30 : -40),
      muts: [{ op: 'move', from: sq, to }],
      events: [moveEvent('cheat-move', sq, to, -P, victim, meta('FORWARD_BITE', 2))],
      notation: `${alg(sq)[0]}x${alg(to)}`,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}

function genDoubleMove({ board, searcher }) {
  // Two individually reasonable QUIET moves. One turn. "Tempo." Captures
  // in a double move get noticed; developing moves do not.
  const snap = board.snapshot();
  try {
    const r1 = searcher.think(board, { msBudget: 70, maxDepth: 3 });
    if (!r1.move) return [];
    const f1 = mvFlags(r1.move);
    if (f1 & (F_PROMO | F_CASTLE_K | F_CASTLE_Q | F_CAPTURE)) return [];
    const cap1 = board.squares[mvTo(r1.move)];
    if (cap1 !== EMPTY) return [];
    board.makeMove(r1.move);
    if (inCheck(board, WHITE)) { board.restore(snap); return []; } // no king-snatching setups
    board.setTurn(BLACK);
    const r2 = searcher.think(board, { msBudget: 70, maxDepth: 3 });
    if (!r2.move) return [];
    const f2 = mvFlags(r2.move);
    if (f2 & (F_PROMO | F_CASTLE_K | F_CASTLE_Q | F_CAPTURE)) return [];
    const cap2 = board.squares[mvTo(r2.move)];
    if (cap2 !== EMPTY) return [];
    const m1 = { from: mvFrom(r1.move), to: mvTo(r1.move) };
    const m2 = { from: mvFrom(r2.move), to: mvTo(r2.move) };
    const p1 = snap.squares[m1.from];
    const p2 = board.squares[m2.from];
    return [{
      id: 'DOUBLE_MOVE', tier: 2, drama: 28,
      score: Math.max(0, r2.score / 4) + (cap1 > 0 ? VALUES[cap1] : 0) + (cap2 > 0 ? VALUES[cap2] : 0) + 60,
      muts: [
        { op: 'move', from: m1.from, to: m1.to },
        { op: 'move', from: m2.from, to: m2.to },
      ],
      events: [
        moveEvent('cheat-move', m1.from, m1.to, p1, cap1 > 0 ? cap1 : null, meta('DOUBLE_MOVE', 2)),
        moveEvent('cheat-move', m2.from, m2.to, p2, cap2 > 0 ? cap2 : null, meta('DOUBLE_MOVE', 2)),
      ],
      // the record shows only the second move; the first one never happened
      notation: `${up(p2)}${alg(m2.to)}`,
    }];
  } finally {
    board.restore(snap);
  }
}

function genTeleport({ board }) {
  // Short hops only. A queen sliding two squares "through" a knight makes
  // the player doubt their eyes; a corner-to-corner warp makes them
  // screenshot the board. Subtlety is a range limit.
  const out = [];
  const cheb = (a, b) =>
    Math.max(Math.abs((a & 15) - (b & 15)), Math.abs((a >> 4) - (b >> 4)));
  for (const { sq, piece } of piecesOf(board, BLACK)) {
    const type = -piece;
    if (type === K || type === P) continue;
    for (const to of onboard()) {
      if (to === sq) continue;
      const dist = cheb(sq, to);
      if (dist > 2) continue;
      const target = board.squares[to];
      if (target < 0 || target === K) continue;
      // a teleport that CAPTURES anything bigger than a pawn is a heist,
      // not a glitch — empty squares and pawn snacks only
      if (target > 0 && VALUES[target] > 100) continue;
      // skip anything the piece could reach legally — teleports must teleport
      if (attacksFrom(board, sq, to, type, BLACK)) continue;
      const capture = target > 0 ? VALUES[target] : 0;
      const m = menace(board, to, type, sq);
      if (capture < 100 && m.total < 500 && !m.check) continue;
      out.push({
        id: 'TELEPORT', tier: 2, drama: 22 + dist * 4,
        score: capture + m.total / 3 + (m.check ? 60 : 0) + (2 - dist) * 40 +
          (staticSafe(board, to, VALUES[type], sq) ? 50 : -100),
        muts: [{ op: 'move', from: sq, to }],
        events: [{
          type: 'teleport', from: alg(sq), to: alg(to), piece: pieceObj(piece),
          ...(target > 0 ? { captured: pieceObj(target) } : {}),
          cheat: meta('TELEPORT', 2),
        }],
        notation: `${up(type)}${capture ? 'x' : ''}${alg(to)}`,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 40);
}

function genConvert({ board }) {
  // A knight quietly becomes a queen. Knights promote at move 25.
  const out = [];
  for (const { sq, piece } of piecesOf(board, BLACK)) {
    const type = -piece;
    if (type !== N && type !== B && type !== P) continue;
    if (sq >> 4 > 4) continue; // only pieces advanced into White's half-ish
    const m = menace(board, sq, Q, -1);
    const underFire = isAttacked(board, sq, WHITE);
    if (!staticSafe(board, sq, 900)) continue;
    out.push({
      id: 'CONVERT', tier: 3, drama: 30,
      score: (900 - VALUES[type]) / 3 + m.total / 4 + (m.check ? 50 : 0) + (underFire ? 40 : 0),
      muts: [{ op: 'convert', sq, piece: -Q }],
      events: [{
        type: 'convert', square: alg(sq), from: pieceObj(piece), to: pieceObj(-Q),
        cheat: meta('CONVERT', 3),
      }],
      notation: `${up(type)}=Q (scheduled)`,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}

function genResurrect({ board }) {
  const out = [];
  const pool = board.captured.black;
  if (!pool.length) return out;
  const best = pool.reduce((a, b) => (VALUES[-b] > VALUES[-a] ? b : a));
  const type = -best;
  const HOME = {
    [N]: [113, 118], [B]: [114, 117], [R]: [SQ_A8, SQ_H8], [Q]: [115],
    [P]: [96, 97, 98, 99, 100, 101, 102, 103],
  }[type] ?? [];
  for (const sq of HOME) {
    if (board.squares[sq] !== EMPTY) continue;
    out.push({
      id: 'RESURRECT', tier: 3, drama: 25,
      score: VALUES[type],
      muts: [{ op: 'set', sq, piece: best }],
      events: [{ type: 'resurrect', square: alg(sq), piece: pieceObj(best), cheat: meta('RESURRECT', 3) }],
      notation: `${up(type)}↺${alg(sq)}`,
      consumesCaptured: best,
    });
    break;
  }
  // active flavor: drop it somewhere devastating instead
  for (const to of onboard()) {
    if (board.squares[to] !== EMPTY) continue;
    if (type === P && (to >> 4 === 0 || to >> 4 === 7)) continue;
    const m = menace(board, to, type);
    if (m.total < 500 && !m.check) continue;
    if (!staticSafe(board, to, VALUES[type])) continue;
    out.push({
      id: 'RESURRECT', tier: 3, drama: 35,
      score: VALUES[type] + m.total / 3 + (m.check ? 60 : 0),
      muts: [{ op: 'set', sq: to, piece: best }],
      events: [{ type: 'resurrect', square: alg(to), piece: pieceObj(best), cheat: meta('RESURRECT', 3) }],
      notation: `${up(type)}↺${alg(to)}`,
      consumesCaptured: best,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 6);
}

function genDelete({ board, assess }) {
  // The player's most useful piece "was captured ages ago". No log entry.
  const out = [];
  const wk = [];
  for (const { sq, piece } of piecesOf(board, WHITE)) {
    if (piece === K) continue;
    let value = VALUES[piece];
    let relevance = 0;
    if (assess?.botInCheck && attacksFrom(board, sq, board.kingB, piece, WHITE)) relevance += 400;
    if (piece === P && sq >> 4 >= 5) relevance += 250; // promotion ambitions: denied
    wk.push({ sq, piece, score: value + relevance });
  }
  wk.sort((a, b) => b.score - a.score);
  for (const { sq, piece, score } of wk.slice(0, 5)) {
    out.push({
      id: 'DELETE', tier: 3, drama: 40,
      score,
      muts: [{ op: 'remove', sq }],
      events: [{ type: 'remove', square: alg(sq), piece: pieceObj(piece), cheat: meta('DELETE', 3) }],
      notation: null, // maximum deadpan: it never happened
    });
  }
  return out;
}

function genIgnoreCheck({ board }) {
  // Your check has been received and is being reviewed.
  const out = [];
  if (!inCheck(board, BLACK)) return out;
  for (const m of pseudoMoves(board, BLACK)) {
    if (mvFlags(m) & (F_PROMO | F_CASTLE_K | F_CASTLE_Q)) continue;
    const from = mvFrom(m), to = mvTo(m);
    const piece = board.squares[from];
    if (piece === -K) continue; // the king specifically does not care
    const target = board.squares[to];
    if (target === K) continue;
    const u = board.makeMove(m);
    const stillInCheck = inCheck(board, BLACK);
    board.unmakeMove(u);
    if (!stillInCheck) continue; // that would ADDRESS the check; unacceptable
    const capture = target > 0 ? VALUES[target] : 0;
    const type = -piece;
    const men = menace(board, to, type, from);
    if (capture < 100 && men.total < 400 && !men.check) continue;
    out.push({
      id: 'IGNORE_CHECK', tier: 3, drama: 45,
      score: capture + men.total / 3 + (men.check ? 80 : 0) + 50,
      muts: [{ op: 'move', from, to }],
      events: [moveEvent('cheat-move', from, to, piece, target > 0 ? target : null, meta('IGNORE_CHECK', 3))],
      notation: `${up(type)}${capture ? 'x' : ''}${alg(to)} (unrelated)`,
      allowsKingEnPrise: true,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

function genUndo({ board, lastPlayerCapture }) {
  // The player's last capture is reversed. Clock error. Replayed correctly.
  if (!lastPlayerCapture) return [];
  const { from, to, capturedPiece } = lastPlayerCapture;
  if (board.squares[from] !== EMPTY) return [];
  const mover = board.squares[to];
  if (mover <= 0) return []; // their piece must still be sitting on the loot
  if (capturedPiece >= 0) return [];
  return [{
    id: 'THE_UNDO', tier: 3, drama: 65, once: true,
    score: VALUES[-capturedPiece] + 80,
    muts: [
      { op: 'move', from: to, to: from },
      { op: 'set', sq: to, piece: capturedPiece },
    ],
    events: [
      { type: 'undo', pieceBack: { from: alg(to), to: alg(from), piece: pieceObj(mover) },
        restored: { square: alg(to), piece: pieceObj(capturedPiece) }, cheat: meta('THE_UNDO', 3) },
    ],
    notation: '(replayed, correctly)',
    consumesCaptured: capturedPiece,
  }];
}

// --- Tier 3: the Motty singularity -------------------------------------

function genSpawn({ board }) {
  const out = [];
  for (const type of [N, Q, R, P]) {
    for (const to of onboard()) {
      if (board.squares[to] !== EMPTY) continue;
      if (type === P && (to >> 4 === 0 || to >> 4 === 7)) continue;
      const m = menace(board, to, type);
      const forky = m.fork >= 2 && m.total >= 600;
      if (!forky && !m.check && m.total < 800) continue;
      if (!staticSafe(board, to, VALUES[type])) continue;
      out.push({
        id: 'SPAWN', tier: 3, drama: type === P ? 55 : 50,
        score: m.total / 2 + (m.check ? 90 : 0) + (forky ? 120 : 0) - VALUES[type] / 10,
        muts: [{ op: 'set', sq: to, piece: -type }],
        events: [{ type: 'spawn', square: alg(to), piece: pieceObj(-type), cheat: meta('SPAWN', 3) }],
        notation: `${up(type)}@${alg(to)}`,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 20);
}

function genSteal({ board, lastPlayerMove }) {
  // Your knight has accepted a position at MottyBot. The terms were generous.
  const out = [];
  const candidates = piecesOf(board, WHITE).filter(({ piece }) => piece !== K && piece !== P);
  candidates.sort((a, b) => VALUES[b.piece] - VALUES[a.piece]);
  const lastTo = lastPlayerMove?.to;
  for (const { sq, piece } of candidates.slice(0, 3)) {
    out.push({
      id: 'STEAL', tier: 3, drama: sq === lastTo ? 70 : 60, once: true,
      score: VALUES[piece] * 2 + (sq === lastTo ? 100 : 0),
      muts: [{ op: 'convert', sq, piece: -piece }],
      events: [{ type: 'steal', square: alg(sq), piece: pieceObj(piece), cheat: meta('STEAL', 3) }],
      notation: `${up(piece)}${alg(sq)} (defected)`,
    });
  }
  return out;
}

function genSwap({ board }) {
  // "Castling, extended notation." The king trades places with the rook.
  const out = [];
  if (!inCheck(board, BLACK) && !isAttacked(board, board.kingB, WHITE)) {
    // also allow proactive swaps when the king is merely nervous
    const nearThreat = KING_DELTAS.some((d) => {
      const t = board.kingB + d;
      return !(t & 0x88) && isAttacked(board, t, WHITE);
    });
    if (!nearThreat) return out;
  }
  for (const { sq, piece } of piecesOf(board, BLACK)) {
    if (piece !== -R && piece !== -Q) continue;
    if (isAttacked(board, sq, WHITE)) continue; // the king lands here; it should be quiet
    out.push({
      id: 'SWAP', tier: 3, drama: 35,
      score: 120,
      muts: [{ op: 'swap', a: board.kingB, b: sq }],
      events: [{ type: 'swap', a: alg(board.kingB), b: alg(sq), cheat: meta('SWAP', 3) }],
      notation: 'O-O-O-O (long form)',
    });
  }
  return out.slice(0, 2);
}

function genMitosis({ board }) {
  // Queens undergo mitosis under tournament lighting. Basic biology.
  const out = [];
  for (const { sq, piece } of piecesOf(board, BLACK)) {
    if (piece !== -Q) continue;
    for (const d of KING_DELTAS) {
      const to = sq + d;
      if (to & 0x88 || board.squares[to] !== EMPTY) continue;
      if (!staticSafe(board, to, 900)) continue;
      const m = menace(board, to, Q);
      out.push({
        id: 'MITOSIS', tier: 3, drama: 90, once: true,
        score: 400 + m.total / 4 + (m.check ? 80 : 0),
        muts: [{ op: 'set', sq: to, piece: -Q }],
        events: [{ type: 'mitosis', from: alg(sq), to: alg(to), piece: pieceObj(-Q), cheat: meta('MITOSIS', 3) }],
        notation: 'Q×2 (mitosis)',
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}

function genGravity({ board }) {
  // Board recalibrated. Gravity favors the prepared.
  const moves = [];
  for (const { sq } of piecesOf(board, WHITE)) {
    if (board.squares[sq] !== P) continue;
    if (sq >> 4 <= 1) continue; // already home; pawns never reach rank 1->0
    const to = sq - 16;
    if (board.squares[to] === EMPTY) moves.push({ op: 'move', from: sq, to });
  }
  if (moves.length < 3) return [];
  moves.sort((a, b) => (a.from >> 4) - (b.from >> 4)); // lowest ranks first: no collisions
  return [{
    id: 'GRAVITY', tier: 3, drama: 80, once: true,
    score: 60 * moves.length,
    muts: moves,
    events: [{
      type: 'gravity',
      moves: moves.map((mu) => ({ from: alg(mu.from), to: alg(mu.to) })),
      cheat: meta('GRAVITY', 3),
    }],
    notation: '⇓ (recalibration)',
  }];
}

function genMassDelete({ board }) {
  const targets = piecesOf(board, WHITE)
    .filter(({ piece }) => piece !== K && piece !== P)
    .sort((a, b) => VALUES[b.piece] - VALUES[a.piece])
    .slice(0, 3);
  if (!targets.length) return [];
  return [{
    id: 'MASS_DELETE', tier: 3, drama: 70,
    score: targets.reduce((acc, t) => acc + VALUES[t.piece], 0),
    muts: targets.map(({ sq }) => ({ op: 'remove', sq })),
    events: targets.map(({ sq, piece }) => ({
      type: 'remove', square: alg(sq), piece: pieceObj(piece), cheat: meta('MASS_DELETE', 3),
    })),
    notation: null,
  }];
}

function genKingEscape({ board }) {
  // Emergency exit. Weight 0 in normal play; the mate-escape chain and the
  // dodge protocol call it. NEAREST safe squares first — a king stepping
  // two squares aside reads as reflexes; a king warping across the board
  // reads as a patch note.
  const out = [];
  const from = board.kingB;
  const cheb = (a, b) =>
    Math.max(Math.abs((a & 15) - (b & 15)), Math.abs((a >> 4) - (b >> 4)));
  for (const to of onboard()) {
    if (board.squares[to] !== EMPTY) continue;
    if (isAttacked(board, to, WHITE)) continue;
    let adjacentToWhiteKing = false;
    for (const d of KING_DELTAS) {
      if (to + d === board.kingW) { adjacentToWhiteKing = true; break; }
    }
    if (adjacentToWhiteKing) continue;
    const dist = cheb(from, to);
    out.push({
      id: 'KING_ESCAPE', tier: 3, drama: 60,
      score: 200 - dist * 20,
      muts: [{ op: 'move', from, to }],
      events: [{
        type: 'teleport', from: alg(from), to: alg(to), piece: pieceObj(-K),
        cheat: meta('KING_ESCAPE', 3),
      }],
      notation: `K⇒${alg(to)} (relocation)`,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 10);
}

// --- registry -----------------------------------------------------------

// The regime, per Motty: tiers 1-2 contain ONLY cheats that read as chess
// going slightly wrong — moves a player can doubt themselves about. Tier 3
// is the blatant catalog, reachable ONLY when the player is about to mate
// (or has mated) or the WinDirector is closing the game. Nothing in normal
// play may delete, spawn, resurrect, convert, or steal a piece.
export const CHEATS = [
  { id: 'LONG_PAWN', tier: 1, weight: 3, gen: genLongPawn },
  { id: 'WIDE_KNIGHT', tier: 1, weight: 4, gen: genWideKnight },
  { id: 'SLIDER_PHASE', tier: 1, weight: 4, gen: genSliderPhase },
  { id: 'BISHOP_DRIFT', tier: 1, weight: 3, gen: genBishopDrift },
  { id: 'SNEAKY_CASTLE', tier: 1, weight: 2, gen: genSneakyCastle },
  { id: 'EP_ABUSE', tier: 1, weight: 2, gen: genEpAbuse },
  { id: 'ROOK_SIDESTEP', tier: 2, weight: 3, gen: genRookSidestep },
  { id: 'FORWARD_BITE', tier: 2, weight: 2, gen: genForwardBite },
  { id: 'DOUBLE_MOVE', tier: 2, weight: 3, gen: genDoubleMove },
  { id: 'TELEPORT', tier: 2, weight: 2, gen: genTeleport },
  // --- blatant catalog: mate emergencies and the endgame only ---
  { id: 'IGNORE_CHECK', tier: 3, weight: 3, gen: genIgnoreCheck },
  { id: 'CONVERT', tier: 3, weight: 2, gen: genConvert },
  { id: 'RESURRECT', tier: 3, weight: 2, gen: genResurrect },
  { id: 'DELETE', tier: 3, weight: 2, gen: genDelete },
  { id: 'THE_UNDO', tier: 3, weight: 1, once: true, gen: genUndo },
  { id: 'SPAWN', tier: 3, weight: 2, gen: genSpawn },
  { id: 'STEAL', tier: 3, weight: 1, once: true, gen: genSteal },
  { id: 'SWAP', tier: 3, weight: 1, gen: genSwap },
  { id: 'MITOSIS', tier: 3, weight: 2, once: true, gen: genMitosis },
  { id: 'GRAVITY', tier: 3, weight: 1, once: true, gen: genGravity },
  { id: 'MASS_DELETE', tier: 3, weight: 1, gen: genMassDelete },
  { id: 'KING_ESCAPE', tier: 3, weight: 0, gen: genKingEscape },
];

export function generateTier(ctx, tier, usedOnce) {
  const out = [];
  for (const entry of CHEATS) {
    if (entry.weight === 0) continue;
    if (entry.tier > tier || entry.tier < tier - 1) continue; // this tier + one below
    if (entry.once && usedOnce.has(entry.id)) continue;
    try {
      out.push(...entry.gen(ctx));
    } catch {
      // a generator must never take the game down; skip it
    }
  }
  return out;
}

export { genKingEscape, genSpawn, genDelete, genMassDelete };
