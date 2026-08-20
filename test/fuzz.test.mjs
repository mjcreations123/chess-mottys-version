import { Chess } from '../js/vendor/chess.js';
import { BlackHoleMatch, replayMatch, firstBlackHoleEligibleSquares } from '../js/core/black-hole.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { assert, ok, summary } from './helpers.mjs';

const GAMES = Number(process.env.FUZZ_GAMES || 80);
const MAX_PLIES = 180;
let turns = 0;
let triggers = 0;
let repeatedSquares = 0;
let kingFalls = 0;
let relocations = 0;
let sharedSquares = 0;
let selfCatches = 0;
let firstPicks = 0;

for (let game = 0; game < GAMES; game++) {
  const match = new BlackHoleMatch(`fuzz-${game}`);
  const mover = makeRng(seedFromString(`moves-${game}`));
  match.selectFallbackBlackHole('w');
  match.selectFallbackBlackHole('b');

  for (let step = 0; step < MAX_PLIES && !match.status().over; step++) {
    const color = match.turn();
    const relocationChoices = match.eligibleRelocationSquares(color);
    let events = [];
    if (relocationChoices.length && mover.next() < 0.055 && match.canRelocateBlackHole(color)) {
      match.relocateBlackHole(color, relocationChoices[mover.int(relocationChoices.length)], { automatic: true });
      relocations++;
    } else {
      const moves = match.legalMoves();
      assert(moves.length > 0, `no legal moves in a live game ${game}:${step}`);
      const chosen = moves[mover.int(moves.length)];
      match.applyMove({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
      events = match.resolveBlackHoleIfDue();
    }
    turns++;

    // Normally one event. A shared square (both players secretly chose the
    // same square) can produce two: one trap now catches anyone, including
    // its own owner, so a single landing can spend both traps at once.
    for (const event of events) {
      triggers++;
      if (event.kingLost) kingFalls++;
      if (event.owner === event.victimColor) selfCatches++;
      assert(event.reopened, `trigger ${game}:${step} did not mark its square reopened`);
      assert(!match.chess.get(event.square), `arriving piece survived on ${event.square} in game ${game}`);
      if (!event.kingLost) {
        assert(match.eligibleBlackHoles(event.owner).includes(event.square),
          `spent square ${event.square} was not eligible in game ${game}`);
      }
    }

    if (match.status().over) break;
    for (const color of ['w', 'b']) {
      if (!match.selectionRequired(color)) continue;
      const previous = match.lastTriggeredSquare(color);
      if (previous && match.eligibleBlackHoles(color).includes(previous) && mover.next() < 0.5) {
        match.selectBlackHole(color, previous, { automatic: true });
        repeatedSquares++;
      } else {
        match.selectFallbackBlackHole(color);
      }
    }
    assert(match.readyToPlay(), `replacement selection stalled game ${game}:${step}`);
    const white = match.activeBlackHole('w');
    const black = match.activeBlackHole('b');
    if (white && white === black) sharedSquares++;
    // A trap can only ever be placed on a square that was empty at the time,
    // and now catches anyone who lands there afterward, its own owner
    // included, so no piece of either color should ever be found resting on
    // an active trap square.
    assert(!white || !match.chess.get(white), `a piece is sitting on white's active black hole at ${white}`);
    assert(!black || !match.chess.get(black), `a piece is sitting on black's active black hole at ${black}`);
    assert(match.relocationsUsed('w') <= 3 && match.relocationsUsed('b') <= 3,
      `relocation limit exceeded in game ${game}:${step}`);
  }

  for (const event of match.log) {
    if (event.kind !== 'placement' || event.sequence !== 1) continue;
    const boardAtPick = new Chess(event.fenAfter);
    const stillAllowed = firstBlackHoleEligibleSquares(boardAtPick, event.color);
    assert(stillAllowed.includes(event.square),
      `first pick ${event.square} for ${event.color} in game ${game} violated the king-proximity/opponent-pawn-row limits`);
    firstPicks++;
  }

  const restored = replayMatch(match.seed, match.serializedActions());
  assert(restored.fen() === match.fen(), `replay FEN drift in game ${game}`);
  assert(restored.blackHolesTriggered() === match.blackHolesTriggered(), `replay trigger count drift in game ${game}`);
  assert(restored.lastTriggeredSquare('w') === match.lastTriggeredSquare('w')
    && restored.lastTriggeredSquare('b') === match.lastTriggeredSquare('b'), `replay spent-square drift in game ${game}`);
  assert(restored.activeBlackHole('w') === match.activeBlackHole('w')
    && restored.activeBlackHole('b') === match.activeBlackHole('b'), `replay active-hole drift in game ${game}`);
  assert(restored.relocationsUsed('w') === match.relocationsUsed('w')
    && restored.relocationsUsed('b') === match.relocationsUsed('b'), `replay relocation count drift in game ${game}`);
  const actual = match.status();
  const replayed = restored.status();
  assert(actual.over === replayed.over && actual.winner === replayed.winner && actual.reason === replayed.reason,
    `replay result drift in game ${game}`);
}

console.log(`  fuzz: ${GAMES} games, ${turns} turns, ${relocations} relocations, ${triggers} triggers, ${repeatedSquares} same-square re-arms, ${sharedSquares} shared-trap states, ${kingFalls} king falls, ${selfCatches} self-catches`);
assert(triggers >= Math.floor(GAMES / 2), `black holes triggered suspiciously rarely: ${triggers} across ${GAMES} games`);
assert(repeatedSquares > 0, 'fuzz run never exercised a same-square rearm');
assert(relocations > 0, 'fuzz run never exercised a voluntary relocation');
assert(sharedSquares > 0, 'fuzz run never exercised overlapping active traps');
assert(selfCatches > 0, 'fuzz run never exercised a trap catching its own owner');
assert(firstPicks === GAMES * 2, `expected exactly two first picks per game, saw ${firstPicks} across ${GAMES} games`);
ok(`${GAMES} random games preserved relocation, one-use trap and replay invariants`);
summary('fuzz.test.mjs');
