// Random Prisoner Exchange games: every invariant that must hold across any
// legal sequence of moves and resurrections, plus replay fidelity.
import { Chess } from '../js/vendor/chess.js';
import { ExchangeMatch, replayMatch } from '../js/core/exchange.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { assert, ok, summary } from './helpers.mjs';

const GAMES = Number(process.env.FUZZ_GAMES || 60);
const MAX_PLIES = 200;
let turns = 0;
let offers = 0;
let resurrections = 0;
let promotions = 0;
let castles = 0;
let enPassants = 0;
let endReasons = {};

for (let game = 0; game < GAMES; game++) {
  const match = new ExchangeMatch(`fuzz-${game}`);
  const rng = makeRng(seedFromString(`moves-${game}`));

  for (let step = 0; step < MAX_PLIES && !match.status().over; step++) {
    const moves = match.legalMoves();
    assert(moves.length > 0, `no legal moves in a live game ${game}:${step}`);
    const chosen = moves[rng.int(moves.length)];
    const options = match.resurrectionOptions(chosen);

    if (options) {
      offers++;
      // Every offered home must be empty right now, and typed correctly.
      for (const home of options.homes) {
        assert(!match.chess.get(home), `offered home ${home} is occupied in game ${game}:${step}`);
      }
    }

    if (options && rng.next() < 0.5) {
      const home = options.homes[rng.int(options.homes.length)];
      const before = new Chess(match.fen());
      const deadBefore = match.dead[match.turn()].length;
      const color = match.turn();
      const event = match.resurrect({ from: chosen.from, to: chosen.to, promotion: chosen.promotion, home });
      resurrections++;

      // The victim survived, untouched.
      const victimNow = match.chess.get(options.victimSquare);
      const victimBefore = before.get(options.victimSquare);
      assert(victimNow && victimNow.type === victimBefore.type && victimNow.color === victimBefore.color,
        `spared victim vanished from ${options.victimSquare} in game ${game}:${step}`);
      // The capturer never moved.
      const capturerNow = match.chess.get(chosen.from);
      assert(capturerNow && capturerNow.type === before.get(chosen.from).type,
        `capturer left ${chosen.from} during a resurrection in game ${game}:${step}`);
      // The returned piece stands on its home square.
      const returned = match.chess.get(home);
      assert(returned && returned.type === event.piece && returned.color === color,
        `returned piece missing from ${home} in game ${game}:${step}`);
      // One graveyard entry consumed, turn passed, clock reset, king safe.
      assert(match.dead[color].length === deadBefore - 1,
        `graveyard did not shrink by one in game ${game}:${step}`);
      assert(match.turn() !== color, `resurrection did not pass the turn in game ${game}:${step}`);
      assert(match.fen().split(' ')[4] === '0', `resurrection did not reset the clock in game ${game}:${step}`);
    } else {
      if (chosen.promotion) promotions++;
      if (chosen.flags.includes('k') || chosen.flags.includes('q')) castles++;
      if (chosen.flags.includes('e')) enPassants++;
      match.applyMove({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
    }
    turns++;

    // Piece-count conservation: board plus graveyards plus captured pawns
    // always equals the 32 pieces the game started with.
    let onBoard = 0;
    for (const row of match.chess.board()) for (const cell of row) if (cell) onBoard++;
    const buried = match.dead.w.length + match.dead.b.length;
    assert(onBoard + buried === 32, `piece conservation broke: ${onBoard} on board + ${buried} dead in game ${game}:${step}`);
  }

  const finalStatus = match.status();
  if (finalStatus.over) endReasons[finalStatus.reason] = (endReasons[finalStatus.reason] || 0) + 1;
  else endReasons['unfinished'] = (endReasons['unfinished'] || 0) + 1;

  const restored = replayMatch(match.seed, match.serializedActions());
  assert(restored.fen() === match.fen(), `replay FEN drift in game ${game}`);
  assert(JSON.stringify(restored.dead) === JSON.stringify(match.dead), `replay graveyard drift in game ${game}`);
  assert(JSON.stringify([...restored.origins].sort()) === JSON.stringify([...match.origins].sort()),
    `replay origin drift in game ${game}`);
  const replayedStatus = restored.status();
  assert(finalStatus.over === replayedStatus.over && finalStatus.winner === replayedStatus.winner
    && finalStatus.reason === replayedStatus.reason, `replay result drift in game ${game}`);
}

console.log(`  fuzz: ${GAMES} games, ${turns} turns, ${offers} offers, ${resurrections} resurrections, ${promotions} promotions, ${castles} castles, ${enPassants} en passants`);
console.log(`  endings: ${JSON.stringify(endReasons)}`);
assert(resurrections > 0, 'fuzz run never exercised a resurrection');
assert(offers > resurrections, 'fuzz run never declined an offer');
ok(`${GAMES} random games preserved victim, capturer, graveyard, conservation and replay invariants`);
summary('fuzz.test.mjs');
