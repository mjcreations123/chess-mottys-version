import { BlackHoleMatch, replayMatch } from '../js/core/black-hole.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { assert, ok, summary } from './helpers.mjs';

const GAMES = Number(process.env.FUZZ_GAMES || 80);
const MAX_PLIES = 180;
let turns = 0;
let collapses = 0;
let kingFalls = 0;

for (let game = 0; game < GAMES; game++) {
  const match = new BlackHoleMatch(`fuzz-${game}`);
  const mover = makeRng(seedFromString(`moves-${game}`));
  match.selectRandomBlackHole('w');
  match.selectRandomBlackHole('b');

  for (let step = 0; step < MAX_PLIES && !match.status().over; step++) {
    const moves = match.legalMoves();
    assert(moves.length > 0, `no legal moves in a live game ${game}:${step}`);
    const chosen = moves[mover.int(moves.length)];
    match.applyMove({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
    const events = match.resolveBlackHoleIfDue();
    turns++;

    if (events.length) {
      collapses++;
      if (events[0].kingLost) kingFalls++;
    }

    for (const square of match.collapsedSquares()) {
      assert(!match.chess.get(square), `piece survived on collapsed ${square} in game ${game}`);
    }
    for (const move of match.legalMoves()) {
      assert(!match.collapsed.has(move.to), `legal move lands on collapsed ${move.to} in game ${game}`);
    }

    if (match.status().over) break;
    for (const color of ['w', 'b']) {
      if (match.selectionRequired(color)) match.selectRandomBlackHole(color);
    }
    assert(match.readyToPlay(), `replacement selection stalled game ${game}:${step}`);
    const white = match.activeBlackHole('w');
    const black = match.activeBlackHole('b');
    if (white && black) assert(white !== black, `active black holes overlap on ${white}`);
    if (white) assert(!match.collapsed.has(white), `white black hole armed on collapsed ${white}`);
    if (black) assert(!match.collapsed.has(black), `black black hole armed on collapsed ${black}`);
  }

  const restored = replayMatch(match.seed, match.serializedActions());
  assert(restored.fen() === match.fen(), `replay FEN drift in game ${game}`);
  assert(JSON.stringify(restored.collapsedSquares()) === JSON.stringify(match.collapsedSquares()), `replay topology drift in game ${game}`);
  assert(restored.activeBlackHole('w') === match.activeBlackHole('w')
    && restored.activeBlackHole('b') === match.activeBlackHole('b'), `replay active-hole drift in game ${game}`);
  const actual = match.status();
  const replayed = restored.status();
  assert(actual.over === replayed.over && actual.winner === replayed.winner && actual.reason === replayed.reason,
    `replay result drift in game ${game}`);
}

console.log(`  fuzz: ${GAMES} games, ${turns} turns, ${collapses} collapses, ${kingFalls} king falls`);
assert(collapses >= GAMES, `black holes triggered suspiciously rarely: ${collapses} across ${GAMES} games`);
ok(`${GAMES} random games preserved black-hole and replay invariants`);
summary('fuzz.test.mjs');
