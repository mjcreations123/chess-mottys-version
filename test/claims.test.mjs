// This week's rule, seen from inside the search. A dead knight, bishop, rook
// or queen is a standing claim on that much material: capture an enemy piece
// of the same kind and yours comes back to its own starting square. The search
// has to see that, or MottyBot parks a piece on its own home square and never
// notices the free returns it is walking past.
import { Chess } from '../js/vendor/chess.js';
import { evaluateFen, think } from '../js/core/engine-ai.js';
import { chooseIndex } from '../js/core/exchange-brain.js';
import { ExchangeMatch, resurrectionFen, START_FEN } from '../js/core/exchange.js';
import { assert, ok, summary } from './helpers.mjs';

const claim = (type, ...homes) => ({ type, homes });

{
  // Identical material and structure. The only difference is whether White's
  // own rook sits on b1, the square its dead knight is owed.
  const clear = '4k3/8/8/8/1n2n3/8/PPP5/R3K3 w - - 0 20';
  const blocked = '4k3/8/8/8/1n2n3/8/PPP5/1R2K3 w - - 0 20';
  const held = { w: [claim('n', 'b1')], b: [] };
  const cost = (evaluateFen(clear, held) - evaluateFen(blocked, held))
    - (evaluateFen(clear, null) - evaluateFen(blocked, null));
  assert(cost > 60, `blocking its own home square cost only ${Math.round(cost)} centipawns`);
  ok('the static verdict charges MottyBot for parking a piece on its own home square');
}

{
  // A claim is only worth something while an enemy piece of that kind is on
  // the board to capture. Same graveyard, same open home, no black knight.
  const fen = '4k3/8/8/8/2b5/8/PPP5/4K3 w - - 0 20';
  const held = { w: [claim('n', 'b1')], b: [] };
  const gap = Math.abs(evaluateFen(fen, held) - evaluateFen(fen, null));
  assert(gap < 1, `an unredeemable claim moved the verdict by ${gap} centipawns`);
  ok('a claim with no matching enemy piece left on the board is worth nothing');
}

{
  // The mirror: the opponent's claim counts against MottyBot, so both sides
  // holding the same claim on a symmetric board cancels out exactly.
  const fen = '1n2k3/8/8/8/8/8/8/1N2K3 w - - 0 20';
  const both = { w: [claim('n', 'b1')], b: [claim('n', 'b8')] };
  const gap = Math.abs(evaluateFen(fen, both) - evaluateFen(fen, null));
  assert(gap < 1, `mirrored claims failed to cancel, off by ${gap} centipawns`);
  ok('an identical claim on both sides cancels out');
}

{
  // Duplicate claims on one kind decay: a turn redeems one piece, so two dead
  // knights are not worth twice one.
  const fen = '1n2k3/8/6n1/8/8/8/8/4K3 w - - 0 20';
  const base = evaluateFen(fen, null);
  const one = evaluateFen(fen, { w: [claim('n', 'b1')], b: [] }) - base;
  const two = evaluateFen(fen, { w: [claim('n', 'b1'), claim('n', 'g1')], b: [] }) - base;
  assert(one > 0, 'a live claim was worth nothing at all');
  assert(two > one, 'a second dead knight added nothing at all');
  assert(two < one * 1.9, `a second dead knight counted almost twice: ${Math.round(one)} then ${Math.round(two)}`);
  ok('a second claim on the same kind is worth less than the first');
}

{
  // A rook is owed two squares, so one of them being occupied is not enough
  // to block the claim.
  const fen = '4k3/8/8/8/1r5r/8/8/R3K3 w - - 0 20';
  const held = { w: [claim('r', 'a1', 'h1')], b: [] };
  const half = evaluateFen(fen, held) - evaluateFen(fen, null);
  const shut = evaluateFen('4k3/8/8/8/1r5r/8/8/R3K2R w - - 0 20', held)
    - evaluateFen('4k3/8/8/8/1r5r/8/8/R3K2R w - - 0 20', null);
  assert(half > shut + 40, `one open home of two was valued like none: ${Math.round(half)} vs ${Math.round(shut)}`);
  ok('a rook owed two squares still has a claim while either one is clear');
}

{
  // The comparator must not credit a homecoming with the claim it just spent.
  const fen = '4k3/2n5/8/3N4/8/8/PPP5/4K3 w - - 0 20';
  const plain = new Chess(fen);
  plain.move({ from: 'd5', to: 'c7' });
  const homecoming = resurrectionFen(fen, 'n', 'w', 'b1');
  assert(homecoming, 'fixture could not build the homecoming');

  const held = { w: [claim('n', 'b1')], b: [] };
  const spent = { w: [], b: [] };
  const wrong = chooseIndex([plain.fen(), homecoming], 'medium', 'spend', 200, [held, held]);
  const right = chooseIndex([plain.fen(), homecoming], 'medium', 'spend', 200, [held, spent]);
  assert(right.scores[1] < wrong.scores[1],
    'spending the claim did not lower the homecoming score, so it was being counted twice');
  ok('a homecoming is not credited with the claim it spends');
}

{
  // End to end through the real match object: the graveyard the search reads
  // is the graveyard the rules keep.
  const match = new ExchangeMatch('claims-e2e');
  const feed = new Chess(START_FEN);
  for (const san of ['e4', 'd5', 'exd5', 'Nf6', 'Nc3', 'Nxd5', 'Nxd5']) {
    const move = feed.moves({ verbose: true }).find((m) => m.san === san);
    assert(move, `fixture lost ${san}`);
    feed.move(move);
    match.applyMove({ from: move.from, to: move.to, promotion: move.promotion });
    match.keepCapture();
  }
  const black = match.vouchers().b;
  assert(black.some((entry) => entry.type === 'n'),
    `Black should be owed a knight, got ${JSON.stringify(black)}`);
  assert(black.every((entry) => entry.type !== 'p'), 'a pawn reached the voucher list');
  assert(black.every((entry) => entry.homes.length > 0), 'a voucher arrived with no home square');
  ok('a live match reports the graveyards the search reads');
}

{
  // A claim must never outweigh a tactic. Holding the biggest claim in the
  // game, MottyBot still has to see mate in one and still has to take a free
  // queen: the rule adds to its judgment, it does not replace it.
  const held = { w: [claim('q', 'd1'), claim('r', 'a1', 'h1')], b: [] };

  const mateIn1 = '6k1/5ppp/8/8/8/7q/5PPP/R5K1 w - - 0 30';
  const mate = think(mateIn1, 'medium', 'claims-mate', { timeMs: 320, blunderChance: 0, vouchers: held });
  assert(mate && mate.from === 'a1' && mate.to === 'a8',
    `holding a claim, MottyBot missed mate in one and played ${JSON.stringify(mate)}`);
  ok('a claim never outweighs a mate in one');

  // The rook is off d1, so the queen claim is fully live: taking Black's last
  // queen collects 9 points and kills that claim in the same move. It still
  // has to take it.
  const freeQueen = '4k3/8/8/3q4/8/3R4/8/4K3 w - - 0 30';
  const grab = think(freeQueen, 'medium', 'claims-grab', { timeMs: 320, blunderChance: 0, vouchers: held });
  assert(grab && grab.from === 'd3' && grab.to === 'd5',
    `holding a claim, MottyBot walked past a free queen and played ${JSON.stringify(grab)}`);
  ok('a claim never outweighs a free queen');
}

summary('claims.test.mjs');
