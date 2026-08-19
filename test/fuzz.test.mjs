import { BlackHoleMatch, replayMatch } from '../js/core/black-hole.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { assert, ok, summary } from './helpers.mjs';

const GAMES = Number(process.env.FUZZ_GAMES || 80);
const MAX_PLIES = 180;
let turns = 0;
let triggers = 0;
let repeatedSquares = 0;
let kingFalls = 0;

for (let game = 0; game < GAMES; game++) {
  const match = new BlackHoleMatch(`fuzz-${game}`);
  const mover = makeRng(seedFromString(`moves-${game}`));
  match.selectFallbackBlackHole('w');
  match.selectFallbackBlackHole('b');

  for (let step = 0; step < MAX_PLIES && !match.status().over; step++) {
    const moves = match.legalMoves();
    assert(moves.length > 0, `no legal moves in a live game ${game}:${step}`);
    const chosen = moves[mover.int(moves.length)];
    match.applyMove({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
    const events = match.resolveBlackHoleIfDue();
    turns++;

    if (events.length) {
      const event = events[0];
      triggers++;
      if (event.kingLost) kingFalls++;
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
      const opponentHole = match.activeBlackHole(color === 'w' ? 'b' : 'w');
      if (previous && previous !== opponentHole && match.eligibleBlackHoles(color).includes(previous) && mover.next() < 0.5) {
        match.selectBlackHole(color, previous, { automatic: true });
        repeatedSquares++;
      } else {
        match.selectFallbackBlackHole(color, [opponentHole]);
      }
    }
    assert(match.readyToPlay(), `replacement selection stalled game ${game}:${step}`);
    const white = match.activeBlackHole('w');
    const black = match.activeBlackHole('b');
    if (white && black) assert(white !== black, `active black holes overlap on ${white}`);
    if (white && match.chess.get(white)) {
      assert(match.chess.get(white).color === 'w', `opponent survived on white black hole ${white}`);
    }
    if (black && match.chess.get(black)) {
      assert(match.chess.get(black).color === 'b', `opponent survived on black black hole ${black}`);
    }
  }

  const restored = replayMatch(match.seed, match.serializedActions());
  assert(restored.fen() === match.fen(), `replay FEN drift in game ${game}`);
  assert(restored.blackHolesTriggered() === match.blackHolesTriggered(), `replay trigger count drift in game ${game}`);
  assert(restored.lastTriggeredSquare('w') === match.lastTriggeredSquare('w')
    && restored.lastTriggeredSquare('b') === match.lastTriggeredSquare('b'), `replay spent-square drift in game ${game}`);
  assert(restored.activeBlackHole('w') === match.activeBlackHole('w')
    && restored.activeBlackHole('b') === match.activeBlackHole('b'), `replay active-hole drift in game ${game}`);
  const actual = match.status();
  const replayed = restored.status();
  assert(actual.over === replayed.over && actual.winner === replayed.winner && actual.reason === replayed.reason,
    `replay result drift in game ${game}`);
}

console.log(`  fuzz: ${GAMES} games, ${turns} turns, ${triggers} triggers, ${repeatedSquares} same-square re-arms, ${kingFalls} king falls`);
assert(triggers >= Math.floor(GAMES / 2), `black holes triggered suspiciously rarely: ${triggers} across ${GAMES} games`);
assert(repeatedSquares > 0, 'fuzz run never exercised a same-square rearm');
ok(`${GAMES} random games preserved one-use trap and replay invariants`);
summary('fuzz.test.mjs');
