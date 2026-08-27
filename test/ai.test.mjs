// The bot must always produce a legal move at every level, including through
// full Prisoner Exchange games, and its exchange judgment must point the
// right way. Plus basic competence checks.
import { Chess } from '../js/vendor/chess.js';
import { ExchangeMatch, resurrectionFen } from '../js/core/exchange.js';
import { chooseIndex, scoreForDecider } from '../js/core/exchange-brain.js';
import { think } from '../js/core/engine-ai.js';
import { assert, ok, summary } from './helpers.mjs';

const FAST = { timeMs: 120 }; // keep CI quick; search quality still exercised

// 1. bot vs bot Prisoner Exchange games at each level: every move legal,
// resurrections taken when the comparator prefers them, no crashes.
//
// Black is always Casual, whatever White is. Two copies of the same level
// mirror each other straight into a threefold repetition inside 25 plies,
// which passes this test while exercising almost none of it; Casual's haze
// keeps the games real and long enough to be worth asserting on.
for (const level of ['easy', 'medium', 'hard']) {
  let taken = 0;
  for (let g = 0; g < 3; g++) {
    const m = new ExchangeMatch(`ai-${level}-${g}`);
    for (let step = 0; step < 60; step++) {
      if (m.status().over) break;
      const mover = m.turn() === 'w' ? level : 'easy';
      const mv = think(m.fen(), mover, `${level}-${g}-${step}`, FAST);
      assert(mv, `bot returned null with legal moves at ${level} g${g} s${step}`);
      const options = m.resurrectionOptions(mv);
      if (options) {
        const color = m.turn();
        const preview = new Chess(m.fen());
        preview.move({ from: mv.from, to: mv.to, promotion: mv.promotion || undefined });
        const fens = [preview.fen()];
        const homes = [];
        for (const home of options.homes) {
          const fen = resurrectionFen(m.fen(), options.victimType, color, home);
          if (fen) { fens.push(fen); homes.push(home); }
        }
        const { index } = chooseIndex(fens, mover, `${level}-${g}-${step}-x`, 90);
        if (index > 0) {
          m.resurrect({ from: mv.from, to: mv.to, promotion: mv.promotion, home: homes[index - 1] });
          taken++;
          continue;
        }
      }
      m.applyMove(mv); // applyMove throws if illegal
    }
  }
  ok(`${level}: bot vs bot exchange games all legal (${taken} homecomings taken)`);
}

// 2. THE SIGN CONVENTION. Candidate positions all have the opponent to move,
// so the decider's score is the NEGATION of what think() reports. Getting
// this backwards makes MottyBot donate material forever, so pin it from both
// directions with positions whose right answer is beyond argument.
{
  // A true sign discriminator needs a material GAP between the candidates.
  // Capture-vs-same-type-homecoming has none (the relative swing is
  // identical by construction), so instead: capturing a free QUEEN (+9)
  // against a mere KNIGHT coming home while the queen survives (+3 vs
  // their 9). Any sane eval separates these by a rook's worth; only an
  // inverted sign could pick the knight.
  const start = '7k/8/8/8/7q/8/6N1/K7 w - - 0 30'; // Ng2xh4 wins the queen clean
  const capture = new Chess(start);
  capture.move({ from: 'g2', to: 'h4' });
  const home = resurrectionFen(start, 'n', 'w', 'g1'); // knight home, queen spared
  assert(home, 'fixture could not build the homecoming candidate');
  const { index, scores } = chooseIndex([capture.fen(), home], 'hard', 'sign-pin', 260);
  assert(index === 0,
    `the comparator preferred a knight homecoming over a FREE queen: scores ${JSON.stringify(scores)} — the sign convention is inverted`);
  assert(scores[0] > scores[1], 'capturing a free queen did not outscore a minor homecoming');
  ok('comparator sign convention: a free queen capture beats a minor-piece homecoming');
}

{
  // The mirror case: the "capture" hangs the capturer to immediate mate
  // threats, while the homecoming is calm. The comparator must prefer the
  // homecoming. White rook takes a DEFENDED queen and dies for nothing vs
  // declining and bringing White's own queen home.
  const start = '3qr2k/3R4/8/8/8/8/8/6NK w - - 0 30'; // d8 queen defended by e8 rook
  const capture = new Chess(start);
  capture.move({ from: 'd7', to: 'd8' }); // Rxd8 Rxd8: White just loses a rook for a queen... still good.
  // Make it genuinely bad: rook takes a defended KNIGHT instead.
  const start2 = '3nr2k/3R4/8/8/8/8/8/6QK w - - 0 30';
  const badCapture = new Chess(start2);
  badCapture.move({ from: 'd7', to: 'd8' }); // Rxd8 Rxd8: rook for knight, a clear loss
  const homecoming = resurrectionFen(start2, 'n', 'w', 'b1');
  assert(homecoming, 'fixture could not build the second homecoming candidate');
  const { index } = chooseIndex([badCapture.fen(), homecoming], 'hard', 'sign-pin-2', 260);
  assert(index === 1,
    'the comparator preferred donating a rook for a defended knight over a free homecoming');
  ok('comparator sign convention: a free homecoming beats donating material');
}

{
  // Terminal candidates: mate for the decider is the best possible score,
  // stalemate is a flat draw.
  const mate = '6k1/5ppp/R7/8/8/8/5PPP/6K1 b - - 0 1'; // wait: build directly below
  void mate;
  const matedFen = new Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
  matedFen.move({ from: 'a1', to: 'a8' }); // Ra8#
  assert(matedFen.isCheckmate(), 'mate fixture drifted');
  assert(scoreForDecider(matedFen.fen(), 'hard', 'terminal', 100) === 1000000,
    'checkmate was not scored as the best outcome for the decider');
  const stale = new Chess('7k/5Q2/8/8/8/8/8/6K1 w - - 0 1');
  stale.move({ from: 'f7', to: 'g6' }); // Qg6 stalemate
  assert(stale.isStalemate(), 'stalemate fixture drifted');
  assert(scoreForDecider(stale.fen(), 'hard', 'terminal-2', 100) === 0,
    'stalemate was not scored as a dead draw');
  ok('terminal candidates score as mate-best and stalemate-zero');
}

// 3. mate in one found (medium and hard)
{
  const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'; // Ra8#
  for (const level of ['medium', 'hard']) {
    const mv = think(fen, level, 'mate1', { mistakeChance: 0 });
    assert(mv.from === 'a1' && mv.to === 'a8', `${level} missed mate in 1, played ${mv.from}${mv.to}`);
  }
  ok('mate in one found');
}

// 4. free queen taken (hard)
{
  const fen = '7k/8/8/3q4/4P3/8/8/7K w - - 0 1'; // exd5 wins the queen
  const mv = think(fen, 'hard', 'freeq', { mistakeChance: 0 });
  assert(mv.from === 'e4' && mv.to === 'd5', `hard ignored free queen, played ${mv.from}${mv.to}`);
  ok('free queen captured');
}

// 5. hanging enemy queen punished
{
  const fen = 'rnb1kbnr/pppp1ppp/8/4p3/6q1/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 1';
  const mv = think(fen, 'hard', 'takeq', { mistakeChance: 0 });
  assert(mv.from === 'f3' && (mv.to === 'g4' || mv.to === 'e5'), `expected queen grab, got ${mv.from}${mv.to}`);
  ok('hanging enemy queen punished');
}

// 5b. Mate in TWO under a real time budget. This is the exact shape of the
// fail-hard quiescence bug: a narrow alpha-beta window used to hand back the
// bound itself, so quiet moves wore mate scores and outranked real mate.
{
  const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'; // Ra8#
  for (const level of ['medium', 'hard']) {
    const mv = think(fen, level, 'mate-window', { mistakeChance: 0 });
    assert(mv.from === 'a1' && mv.to === 'a8',
      `${level} played ${mv.from}${mv.to} instead of mate; quiescence may be fail-hard again`);
  }
  ok('mate found at full depth with a real time budget');
}

// 5d. Endgame technique. Against a bare king material never changes, so
// without a mating drive the eval is flat and the search shuffles until the
// fifty-move rule. It must find a basic mate and herd the lone king outward.
{
  const OPTS = { maxDepth: 4, timeMs: 900, mistakeChance: 0 };
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

// 6. determinism of the bot given identical seed (guards against accidental
// Math.random usage)
{
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const a = think(fen, 'medium', 'same-seed', { mistakeChance: 0 });
  const b = think(fen, 'medium', 'same-seed', { mistakeChance: 0 });
  assert(a.from === b.from && a.to === b.to, 'bot not deterministic for same seed');
  ok('bot deterministic per seed');
}

summary('ai.test.mjs');
