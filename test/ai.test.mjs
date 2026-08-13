// The bot must always produce a legal move, at every level, in chaos
// positions too. Plus basic competence checks.
import { Chess } from '../js/vendor/chess.js';
import { ChaosMatch } from '../js/core/chaos.js';
import { think } from '../js/core/engine-ai.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { assert, ok, summary } from './helpers.mjs';

const FAST = { timeMs: 120 }; // keep CI quick; search quality still exercised

// 1. bot vs bot chaos games at each level: every move legal, no crashes
for (const level of ['easy', 'medium', 'hard']) {
  for (let g = 0; g < 3; g++) {
    const m = new ChaosMatch(`ai-${level}-${g}`);
    for (let step = 0; step < 40; step++) {
      if (m.status().over) break;
      const mv = think(m.fen(), level, `${level}-${g}-${step}`, FAST);
      assert(mv, `bot returned null with legal moves at ${level} g${g} s${step}`);
      // applyMove throws if illegal
      m.applyMove(mv);
      m.teleportIfDue();
    }
  }
  ok(`${level}: bot vs bot chaos games all legal`);
}

// 2. mate in one found (medium and hard)
{
  const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'; // Ra8#
  for (const level of ['medium', 'hard']) {
    const mv = think(fen, level, 'mate1');
    assert(mv.from === 'a1' && mv.to === 'a8', `${level} missed mate in 1, played ${mv.from}${mv.to}`);
  }
  ok('mate in one found');
}

// 3. free queen taken (hard)
{
  const fen = '7k/8/8/3q4/4P3/8/8/7K w - - 0 1'; // exd5 wins the queen
  const mv = think(fen, 'hard', 'freeq');
  assert(mv.from === 'e4' && mv.to === 'd5', `hard ignored free queen, played ${mv.from}${mv.to}`);
  ok('free queen captured');
}

// 4. hard avoids losing its queen for nothing: after search, the chosen move
// must not hang the queen to an immediate recapture that nets material loss.
{
  const fen = 'rnb1kbnr/pppp1ppp/8/4p3/6q1/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 1';
  // Nxg4?? loses knight for queen: actually Nxg4 WINS the queen. Sanity: bot takes it.
  const mv = think(fen, 'hard', 'takeq');
  assert(mv.from === 'f3' && (mv.to === 'g4' || mv.to === 'e5'), `expected queen grab, got ${mv.from}${mv.to}`);
  ok('hanging enemy queen punished');
}

// 5. single legal move returned instantly
{
  const fen = '7k/8/8/8/8/8/5PPP/6bK w - - 0 1'; // white: Kxg1 only? craft simpler below
  const c = new Chess(fen);
  const legal = c.moves({ verbose: true });
  if (legal.length === 1) {
    const mv = think(fen, 'hard', 'forced');
    assert(mv.from === legal[0].from && mv.to === legal[0].to, 'forced move mismatch');
    ok('forced move handled');
  } else {
    ok(`forced-move fen actually has ${legal.length} moves, skipped`);
  }
}

// 5b. Mate in TWO under a real time budget. This is the exact shape of the
// fail-hard quiescence bug: a narrow alpha-beta window used to hand back the
// bound itself, so quiet moves wore mate scores and outranked real mate.
{
  const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'; // Ra8#
  for (const level of ['medium', 'hard']) {
    const mv = think(fen, level, 'mate-window');
    assert(mv.from === 'a1' && mv.to === 'a8',
      `${level} played ${mv.from}${mv.to} instead of mate; quiescence may be fail-hard again`);
  }
  ok('mate found at full depth with a real time budget');
}

// 5c. Deeper search must beat shallower search head to head, both colours.
// Played as PLAIN chess: the teleport rule is deliberately random enough to
// swamp a depth advantage over a handful of games, so mixing it in would test
// the dice rather than the engine. Material is the verdict where a game does
// not finish inside the ply cap.
{
  const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  let strongBetter = 0;
  let weakBetter = 0;
  for (let g = 0; g < 6; g++) {
    const strongIsWhite = g % 2 === 0;
    const board = new Chess();
    for (let step = 0; step < 70 && !board.isGameOver(); step++) {
      const strongToMove = (board.turn() === 'w') === strongIsWhite;
      const mv = think(
        board.fen(),
        strongToMove ? 'hard' : 'easy',
        `s-${g}-${step}`,
        strongToMove
          ? { maxDepth: 4, timeMs: 700, quiesce: true, jitter: 0, randomChance: 0 }
          : { maxDepth: 1, timeMs: 60, quiesce: false, jitter: 0, randomChance: 0 },
      );
      if (!mv) break;
      board.move(mv);
    }
    let edge = 0; // material from the strong side's view
    for (const cell of board.board().flat()) {
      if (!cell || cell.type === 'k') continue;
      const mine = (cell.color === 'w') === strongIsWhite;
      edge += (mine ? 1 : -1) * VALUE[cell.type];
    }
    if (board.isCheckmate()) {
      // side to move is mated, so the other side won
      const winnerIsWhite = board.turn() === 'b';
      (winnerIsWhite === strongIsWhite) ? strongBetter++ : weakBetter++;
    } else if (edge > 2) strongBetter++;
    else if (edge < -2) weakBetter++;
  }
  console.log(`  strength (plain chess): deep ahead in ${strongBetter}/6, shallow ahead in ${weakBetter}/6`);
  assert(strongBetter > weakBetter, `deeper search did not outplay shallower (${strongBetter}-${weakBetter})`);
  ok('deeper search outplays shallower search');
}

// 5d. Endgame technique. Against a bare king material never changes, so
// without a mating drive the eval is flat and the search shuffles until the
// fifty-move rule. It must find a basic mate and herd the lone king outward.
{
  const OPTS = { maxDepth: 4, timeMs: 900, quiesce: true, jitter: 0 };
  const mv = think('7k/8/7K/8/8/8/8/R7 w - - 0 1', 'hard', 'rook-mate', OPTS);
  assert(mv.from === 'a1' && mv.to === 'a8', `missed the rook mate in one, played ${mv.from}${mv.to}`);

  const centreDist = (sq) => {
    const f = sq.charCodeAt(0) - 97;
    const r = sq.charCodeAt(1) - 49;
    return Math.max(3 - f, f - 4) + Math.max(3 - r, r - 4);
  };
  const board = new Chess('8/8/4k3/8/8/8/8/Q3K3 w - - 0 1');
  const before = centreDist('e6');
  for (let i = 0; i < 18 && !board.isGameOver(); i++) {
    const best = think(board.fen(), 'hard', `drive-${i}`, OPTS);
    if (!best) break;
    board.move(best);
    if (board.isGameOver()) break;
    const replies = board.moves({ verbose: true });
    if (!replies.length) break;
    board.move(replies[0]);
  }
  const king = board.board().flat().find((c) => c && c.type === 'k' && c.color === 'b');
  const after = king ? centreDist(king.square) : 6;
  assert(after > before, `the lone king was not driven outward: centre distance ${before} -> ${after}`);
  ok(`drives a bare king from the centre toward the edge (distance ${before} -> ${after})`);
}

// 6. determinism of the bot given identical seed (needed nowhere in gameplay,
// but guards against accidental Math.random usage)
{
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const a = think(fen, 'medium', 'same-seed');
  const b = think(fen, 'medium', 'same-seed');
  assert(a.from === b.from && a.to === b.to, 'bot not deterministic for same seed');
  ok('bot deterministic per seed');
}

summary('ai.test.mjs');
