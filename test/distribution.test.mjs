// Statistical guard for the public claim that Fate is random. Each eligible
// piece must have the same chance of being selected, independent of how many
// empty destinations that piece has. Once selected, each of its destinations
// must have the same chance as the others.
import { Chess } from '../js/vendor/chess.js';
import { runTeleportPhase, validTeleportDests } from '../js/core/teleport.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { assert, ok, summary } from './helpers.mjs';

const FEN = '7k/8/8/8/8/8/8/KNB5 b - - 0 1';
const RUNS = 24000;
// This file measures the DRAW, not how often Fate acts. With two pieces left
// Fate deliberately passes most turns (see fairness.test.mjs), so force it to
// act every time and the two concerns stay separately testable.
const ALWAYS = { fullForceAt: 1 };
const pieces = new Map([['b1', 0], ['c1', 0]]);
const knightDests = new Map(validTeleportDests(new Chess(FEN), 'b1').map((sq) => [sq, 0]));

for (let i = 0; i < RUNS; i++) {
  const chess = new Chess(FEN);
  const ev = runTeleportPhase(chess, makeRng(seedFromString(`distribution-${i}`)), 'w', ALWAYS)[0];
  assert(ev, `missing event at run ${i}`);
  pieces.set(ev.from, (pieces.get(ev.from) || 0) + 1);
  if (ev.from === 'b1') knightDests.set(ev.to, (knightDests.get(ev.to) || 0) + 1);
}

const pieceExpected = RUNS / 2;
for (const [from, count] of pieces) {
  const drift = Math.abs(count - pieceExpected) / pieceExpected;
  assert(drift < 0.03, `${from} selection drift ${(drift * 100).toFixed(2)}%`);
}
ok('eligible pieces are selected uniformly');

const knightTotal = pieces.get('b1');
const destExpected = knightTotal / knightDests.size;
for (const [to, count] of knightDests) {
  const drift = Math.abs(count - destExpected) / destExpected;
  assert(drift < 0.34, `${to} destination drift ${(drift * 100).toFixed(1)}%`);
}
ok('eligible destinations are selected uniformly');

// Draw outcomes must depend only on the game seed and ply, never a hidden
// side channel such as AI search time or move choice ordering.
for (let ply = 1; ply <= 500; ply++) {
  const left = new Chess(FEN);
  const right = new Chess(FEN);
  const seed = seedFromString(`phase-contract#${ply}`);
  const a = runTeleportPhase(left, makeRng(seed), 'w', ALWAYS)[0];
  const b = runTeleportPhase(right, makeRng(seed), 'w', ALWAYS)[0];
  assert(a.from === b.from && a.to === b.to, `phase ${ply} was not reproducible`);
}
ok('teleport outcomes are reproducible from seed and ply alone');

summary('distribution.test.mjs');
