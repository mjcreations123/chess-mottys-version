// Not a test: the yardstick for the three difficulty levels.
//
// It plays each MottyBot level against reference opponents of understood
// strength, under the full Prisoner Exchange rules, and reports win rates.
// "Casual should be easy to win" is a claim about a human, and the only
// honest way to check it is to put a stand-in for that human across the board.
//
//   node test/level-ladder-probe.mjs                    the ladder report
//   node test/level-ladder-probe.mjs 24 easy grabby     one pairing matrix
//
// The ladder report is the one that answers "are the three levels playing
// accordingly". It needs BOTH halves: the human stand-ins say whether Casual
// is beatable, and the level-against-level games say whether the three are
// actually different, because every stand-in loses to all three.
//
// RUN IT SERIALLY ON AN IDLE MACHINE. The levels are wall-clock budgeted
// (LEVELS[x].timeMs), so anything else competing for CPU makes the numbers
// lie: a loaded machine quietly turns Expert into Average.
//
// What this measured, 2026-08-27. Percentages are how often the OPPONENT wins.
//
//                     novice   casual player   good player
//   Casual              48%         96%           100%
//   Average              0%          0%            61%
//   Expert                -           -             0%
//
// Two things mattered more than the numbers. First, a level that is nudged off
// its best move on every turn does not look weak, it looks like it is not
// trying: Casual now plays the move it actually found 70% of the time and is
// still easier to beat than the version that managed 3%. Weakness belongs in
// what it can SEE, not in whether it acts on what it sees. Second, the
// transposition table lifted every level at once, so the whole ladder had to
// be retuned underneath it.

import { Chess } from '../js/vendor/chess.js';
import { ExchangeMatch, resurrectionFen, replayMatch } from '../js/core/exchange.js';
import { chooseIndex } from '../js/core/exchange-brain.js';
import { think, LEVELS } from '../js/core/engine-ai.js';
import { makeRng, seedFromString } from '../js/core/rng.js';

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 950, k: 0 };
const PLY_CAP = 200;
const PROBE_MS = { easy: 140, medium: 260, hard: 420 };

/* ------------------------------------------------------------------ *
 * Reference opponents.
 *
 * Each one stands in for a band of human play. They are deliberately
 * simple: the point is that their blind spots are KNOWN, so a win rate
 * against them means something.
 * ------------------------------------------------------------------ */

// Everything a reference is allowed to look at, so none of them can reach
// into the engine by accident.
function view(match) {
  const fen = match.fen();
  const chess = new Chess(fen);
  return { fen, chess, moves: chess.moves({ verbose: true }), vouchers: match.vouchers() };
}

// Is the square defended by the side that is NOT to move? Used by the
// references that check whether a capture walks into a recapture.
function defended(chess, square, byColor) {
  return chess.attackers(square, byColor).length > 0;
}

// Material from `color`'s point of view, in centipawns.
function material(chess, color) {
  let total = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      total += cell.color === color ? VAL[cell.type] : -VAL[cell.type];
    }
  }
  return total;
}

export const REFERENCES = {
  // The floor. Beats nobody, loses to everything. Its only job is to prove a
  // level is not somehow losing to noise.
  random: {
    label: 'random mover',
    stands_for: 'no chess knowledge at all',
    pick({ moves }, rng) { return moves[rng.int(moves.length)]; },
  },

  // A true novice: sees material one move at a time, takes anything that
  // looks free, and does not think about the reply. Blind to every threat
  // against it. Roughly the first month of playing chess.
  grabby: {
    label: 'grabby novice',
    stands_for: 'takes what looks free, never checks the reply',
    pick({ chess, moves }, rng) {
      const captures = moves.filter((m) => m.captured);
      if (captures.length) {
        let best = captures[0];
        for (const m of captures) if (VAL[m.captured] > VAL[best.captured]) best = m;
        return best;
      }
      const quiet = moves.filter((m) => m.piece !== 'k');
      return (quiet.length ? quiet : moves)[rng.int(quiet.length || moves.length)];
    },
  },

  // A careful beginner: takes free material, but checks whether the square it
  // lands on is defended, and will not leave the piece it just moved hanging
  // for nothing. Still blind to forks, pins, and anything two moves deep.
  // This is the reference that matters for "Casual should be easy to win":
  // it is roughly the strength of the friends Motty sends this to.
  beginner: {
    label: 'careful beginner',
    stands_for: 'takes free material, avoids obvious recaptures, no lookahead',
    pick({ chess, moves }, rng) {
      const me = chess.turn();
      const them = me === 'w' ? 'b' : 'w';
      let bestScore = -Infinity;
      let pool = [];
      for (const m of moves) {
        const after = new Chess(chess.fen());
        after.move({ from: m.from, to: m.to, promotion: m.promotion || undefined });
        let score = VAL[m.captured] || 0;
        if (m.promotion) score += VAL[m.promotion] - VAL.p;
        // Would it just be taken back? A beginner checks the square, not the
        // whole tactic, so this is a one-square glance and nothing more.
        if (defended(after, m.to, them)) score -= VAL[m.piece];
        if (after.isCheckmate()) score += 100000;
        // A nudge off the back rank so it develops rather than shuffling.
        if (m.piece !== 'p' && m.piece !== 'k') score += 6;
        score += rng.next() * 4; // break ties without a fixed move-order bias
        if (score > bestScore) { bestScore = score; pool = [m]; }
        else if (score === bestScore) pool.push(m);
      }
      return pool[rng.int(pool.length)];
    },
  },

  // A real player. Three plies with the captures resolved at the end of them,
  // and an actual positional opinion. Deliberately built from the same search
  // as MottyBot but pinned to a FIXED configuration that no difficulty level
  // can change, so it stays the same yardstick from week to week.
  //
  // This one stands in for someone who is genuinely good at chess. It is the
  // yardstick for Average: a good player should beat Average, and should still
  // lose to Expert.
  clubPlayer: {
    label: 'club player',
    stands_for: 'three plies with the captures resolved, and a positional opinion',
    pick(state, rng, seed) {
      const move = think(state.fen, 'medium', seed, {
        maxDepth: 3, timeMs: 1500, mistakeChance: 0, endgameBonus: 0,
        vouchers: state.vouchers,
      });
      if (!move) return state.moves[rng.int(state.moves.length)];
      return state.moves.find((m) => m.from === move.from && m.to === move.to
        && (m.promotion || undefined) === (move.promotion || undefined))
        || state.moves[rng.int(state.moves.length)];
    },
  },

  // Two plies of honest minimax on material alone, no quiescence. Sees a
  // capture and the recapture, so it wins a piece when one is offered and
  // does not usually give one away. This is roughly someone who plays
  // occasionally and is not especially good at it.
  improver: {
    label: 'two-ply improver',
    stands_for: 'sees the capture and the recapture, nothing further',
    pick({ chess, moves }, rng) {
      const me = chess.turn();
      let bestScore = -Infinity;
      let pool = [];
      for (const m of moves) {
        const after = new Chess(chess.fen());
        after.move({ from: m.from, to: m.to, promotion: m.promotion || undefined });
        let score;
        if (after.isCheckmate()) score = 100000;
        else if (after.isStalemate()) score = 0;
        else {
          // the opponent's best single reply, by material only
          let worst = Infinity;
          for (const reply of after.moves({ verbose: true })) {
            const then = new Chess(after.fen());
            then.move({ from: reply.from, to: reply.to, promotion: reply.promotion || undefined });
            const value = then.isCheckmate() ? -100000 : material(then, me);
            if (value < worst) worst = value;
          }
          score = worst;
        }
        score += rng.next() * 4;
        if (score > bestScore) { bestScore = score; pool = [m]; }
        else if (score === bestScore) pool.push(m);
      }
      return pool[rng.int(pool.length)];
    },
  },
};

// Did the side that just moved leave something hanging? One capture, one
// recapture, material only. This separates "beatable" from "broken": a level
// that hangs a piece on most moves is not weak, it is unwatchable.
function hangingValue(fen) {
  const chess = new Chess(fen);
  const grabber = chess.turn();
  const owner = grabber === 'w' ? 'b' : 'w';
  let best = 0;
  for (const m of chess.moves({ verbose: true })) {
    if (!m.captured) continue;
    const after = new Chess(fen);
    after.move({ from: m.from, to: m.to, promotion: m.promotion || undefined });
    let gain = VAL[m.captured];
    if (after.attackers(m.to, owner).length) gain -= VAL[m.piece];
    if (gain > best) best = gain;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Turn drivers
 * ------------------------------------------------------------------ */

function vouchersAfter(match, action) {
  try {
    return replayMatch(match.seed, [...match.serializedActions(), action]).vouchers();
  } catch { return match.vouchers(); }
}

// Every homecoming open to the side to move, deduplicated by home square.
function alternatives(match) {
  const color = match.turn();
  const out = [];
  const seen = new Set();
  for (const move of match.legalMoves()) {
    const options = match.resurrectionOptions(move);
    if (!options) continue;
    for (const home of options.homes) {
      if (seen.has(home)) continue;
      seen.add(home);
      const fen = resurrectionFen(match.fen(), options.victimType, color, home);
      if (!fen) continue;
      const uci = move.from + move.to + (move.promotion || '');
      out.push({ move, home, fen, vouchers: vouchersAfter(match, { kind: 'resurrect', uci, home }) });
    }
  }
  return out;
}

// One MottyBot turn, driven exactly the way js/main.js drives it: think for
// the move, then weigh that move against every homecoming.
function botTurn(match, level, seed, probeMs, override) {
  const move = think(match.fen(), level, seed, { ...override, vouchers: match.vouchers() });
  if (!move) return null;
  const alts = alternatives(match);
  if (alts.length) {
    const preview = new Chess(match.fen());
    preview.move({ from: move.from, to: move.to, promotion: move.promotion || undefined });
    const fens = [preview.fen(), ...alts.map((a) => a.fen)];
    const list = [
      vouchersAfter(match, { kind: 'move', uci: move.from + move.to + (move.promotion || '') }),
      ...alts.map((a) => a.vouchers),
    ];
    const { index } = chooseIndex(fens, level, `${seed}#x`, probeMs, list);
    if (index > 0) {
      const alt = alts[index - 1];
      match.applyMove({ from: alt.move.from, to: alt.move.to, promotion: alt.move.promotion });
      match.takeHomecoming(alt.home);
      return 'resurrect';
    }
  }
  match.applyMove(move);
  match.keepCapture();
  return 'move';
}

// One reference turn. The reference picks by its own rule, then takes any
// homecoming it is offered: getting a piece back is the obvious read of the
// rule, and it keeps the references simple enough to reason about.
function referenceTurn(match, reference, rng, seed) {
  const state = view(match);
  if (!state.moves.length) return null;
  const choice = reference.pick(state, rng, seed);
  const applied = match.applyMove({ from: choice.from, to: choice.to, promotion: choice.promotion });
  const offer = match.pendingResurrection();
  if (offer) {
    try {
      match.takeHomecoming(offer.homes[0]);
      return 'resurrect';
    } catch { /* fall through and keep the capture */ }
  }
  match.keepCapture();
  void applied;
  return 'move';
}

/* ------------------------------------------------------------------ *
 * The match loop
 * ------------------------------------------------------------------ */

// `reference` is either one of REFERENCES or, when opponentLevel is given,
// another MottyBot level. Level against level is the only honest way to show
// the ladder: the human stand-ins all lose to every level, so they cannot
// tell Average and Expert apart.
export function playGame({ level, reference, seed, botIsWhite, probeMs, override, opponentLevel }) {
  const match = new ExchangeMatch(seed);
  const rng = makeRng(seedFromString(`${seed}#ref`));
  const botColor = botIsWhite ? 'w' : 'b';
  let ply = 0;
  let botMoves = 0;
  let botHangs = 0;
  let botReturns = 0;
  for (; ply < PLY_CAP; ply++) {
    if (match.status().over) break;
    const turn = match.turn();
    const kind = turn === botColor
      ? botTurn(match, level, `${seed}#${ply}`, probeMs, override)
      : opponentLevel
        ? botTurn(match, opponentLevel, `${seed}#opp#${ply}`, PROBE_MS[opponentLevel] ?? 260)
        : referenceTurn(match, reference, rng, `${seed}#ref#${ply}`);
    if (!kind) break;
    if (turn === botColor) {
      botMoves++;
      if (kind === 'resurrect') botReturns++;
      if (!match.status().over && hangingValue(match.fen()) >= 300) botHangs++;
    }
  }
  const status = match.status();
  const chess = new Chess(match.fen());
  const edge = material(chess, botColor);
  if (!status.over || !status.winner) {
    // A game that ran out of plies is not a draw, it is unfinished. Score it
    // by material so a crushing position is not filed next to a real draw.
    if (!status.over && Math.abs(edge) >= 500) {
      return { result: edge > 0 ? 'bot' : 'reference', reason: 'material at the ply cap', ply, edge, botMoves, botHangs, botReturns };
    }
    return { result: 'draw', reason: status.reason || 'ply cap', ply, edge, botMoves, botHangs, botReturns };
  }
  return {
    result: status.winner === botColor ? 'bot' : 'reference',
    reason: status.reason, ply, edge, botMoves, botHangs, botReturns,
  };
}

// One level against one reference. Exported so a tuning sweep can drive it
// with a config override without starting the whole tournament.
export function runPairing({ level, refKey, games, probeMs, override, seedTag = 'ladder' }) {
  // "level:medium" pits this level against another MottyBot level.
  const opponentLevel = refKey.startsWith('level:') ? refKey.slice(6) : null;
  const reference = opponentLevel ? null : REFERENCES[refKey];
  if (!opponentLevel && !reference) throw new Error(`no reference called ${refKey}`);
  if (opponentLevel && !LEVELS[opponentLevel]) throw new Error(`no level called ${opponentLevel}`);
  const tally = { bot: 0, reference: 0, draw: 0 };
  const reasons = {};
  let plies = 0;
  let botMoves = 0;
  let botHangs = 0;
  let botReturns = 0;
  const started = Date.now();
  for (let g = 0; g < games; g++) {
    const outcome = playGame({
      level, reference, override, probeMs, opponentLevel,
      seed: `${seedTag}-${level}-${refKey}-${g}`,
      botIsWhite: g % 2 === 0,
    });
    tally[outcome.result]++;
    reasons[outcome.reason] = (reasons[outcome.reason] || 0) + 1;
    plies += outcome.ply;
    botMoves += outcome.botMoves;
    botHangs += outcome.botHangs;
    botReturns += outcome.botReturns;
  }
  return {
    level, reference: refKey,
    botWins: tally.bot, refWins: tally.reference, draws: tally.draw,
    humanScorePct: Math.round((tally.reference + tally.draw / 2) / games * 100),
    hangPct: botMoves ? Math.round(botHangs / botMoves * 100) : 0,
    returnsPerGame: Math.round(botReturns / games * 10) / 10,
    avgPly: Math.round(plies / games),
    seconds: Math.round((Date.now() - started) / 1000),
    reasons,
  };
}

/* ------------------------------------------------------------------ */

const RUN_TOURNAMENT = Boolean(process.argv[1] && process.argv[1].includes('level-ladder-probe'));

const GAMES = Number(process.argv[2] || 20);
const LEVEL_LIST = (process.argv[3] || 'easy,medium,hard').split(',');
const REF_LIST = (process.argv[4] || 'grabby,beginner,improver').split(',');
const PROBE = PROBE_MS;

// No arguments: the ladder report. Each level against the human stand-ins,
// then each level against the one below it.
function ladderReport(games, slowGames) {
  const rows = [];
  const show = (title, row) => {
    rows.push({ title, ...row });
    console.log(`${title.padEnd(30)} bot ${String(row.botWins).padStart(2)} | opp ${String(row.refWins).padStart(2)} | draw ${String(row.draws).padStart(2)}   opponent scores ${String(row.humanScorePct).padStart(3)}%   hangs ${String(row.hangPct).padStart(2)}%   homecomings/game ${row.returnsPerGame}  (${row.seconds}s)`);
  };
  console.log('LADDER REPORT. Run this alone: the levels are wall-clock budgeted.');
  for (const [level, refKey, n] of [
    ['easy', 'beginner', games], ['easy', 'improver', slowGames],
    ['medium', 'beginner', games], ['medium', 'improver', slowGames],
    ['hard', 'improver', slowGames],
  ]) show(`${level} vs ${refKey}`, runPairing({ level, refKey, games: n, probeMs: PROBE_MS[level], seedTag: 'lad' }));
  show('medium vs easy (head to head)',
    runPairing({ level: 'medium', refKey: 'level:easy', games, probeMs: PROBE_MS.medium, seedTag: 'lad' }));
  show('hard vs medium (head to head)',
    runPairing({ level: 'hard', refKey: 'level:medium', games: slowGames, probeMs: PROBE_MS.hard, seedTag: 'lad' }));
  console.log(JSON.stringify(rows, null, 1));
}

if (RUN_TOURNAMENT && process.argv.length <= 2) {
  ladderReport(16, 10);
} else if (RUN_TOURNAMENT) {
console.log(`Prisoner Exchange ladder, ${GAMES} games per pairing, alternating colors.`);
console.log(`Levels: ${LEVEL_LIST.map((l) => `${l} (${LEVELS[l].label})`).join(', ')}`);
console.log('Run this alone: the levels are wall-clock budgeted and CPU contention flatters the weak ones.\n');

const table = [];
for (const level of LEVEL_LIST) {
  for (const refKey of REF_LIST) {
    const row = runPairing({ level, refKey, games: GAMES, probeMs: PROBE[level] ?? 260 });
    row.label = LEVELS[level].label;
    table.push(row);
    console.log(`${level.padEnd(7)} vs ${refKey.padEnd(9)}  bot ${String(row.botWins).padStart(2)} | ref ${String(row.refWins).padStart(2)} | draw ${String(row.draws).padStart(2)}  ->  reference scores ${String(row.humanScorePct).padStart(3)}%   hangs on ${String(row.hangPct).padStart(2)}% of its moves  (${row.seconds}s)`);
  }
}

console.log(`\n${JSON.stringify(table, null, 1)}`);
}
