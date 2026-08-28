// The UI deliberately plays a qualifying capture before offering the player a
// decision. These tests exercise that *deferred* path repeatedly, rather than
// only calling resurrect() directly from the pre-capture position.
import { ExchangeMatch, replayMatch } from '../js/core/exchange.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { assert, ok, summary } from './helpers.mjs';

const GAMES = Number(process.env.EXCHANGE_LIFECYCLE_GAMES || 90);
const MAX_PLIES = 180;

function identity(match) {
  return JSON.stringify({
    fen: match.fen(),
    dead: match.dead,
    origins: [...match.origins].sort(([a], [b]) => a.localeCompare(b)),
    actions: match.serializedActions(),
    status: match.status(),
    ply: match.ply,
  });
}

function expectThrow(fn, pattern, message) {
  try {
    fn();
  } catch (error) {
    assert(pattern.test(String(error?.message || error)), `${message}: wrong error ${error?.message || error}`);
    return;
  }
  throw new Error(`ASSERT: ${message}: did not throw`);
}

function placement(fen) { return fen.split(' ')[0]; }

let offers = 0;
let homecomings = 0;
let keeps = 0;

for (let game = 0; game < GAMES; game++) {
  const match = new ExchangeMatch(`lifecycle-${game}`);
  const rng = makeRng(seedFromString(`lifecycle-rng-${game}`));

  for (let ply = 0; ply < MAX_PLIES && !match.status().over; ply++) {
    const legal = match.legalMoves();
    assert(legal.length, `no legal move in live lifecycle game ${game}:${ply}`);
    const chosen = legal[rng.int(legal.length)];
    const options = match.resurrectionOptions(chosen);

    if (!options) {
      const beforeFen = match.fen();
      match.applyMove({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
      assert(placement(match.fen()) !== placement(beforeFen),
        `normal move did not change board placement in lifecycle game ${game}:${ply}`);
      match.keepCapture();
      continue;
    }

    offers++;
    // This is the exact position direct resurrection must produce if the
    // player later chooses to undo the capture.
    const direct = replayMatch(match.seed, match.serializedActions());
    const before = identity(match);
    const played = match.applyMove({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
    const pending = match.pendingResurrection();
    assert(pending && JSON.stringify(pending) === JSON.stringify(options),
      `offer changed after its capture in game ${game}:${ply}`);
    assert(played.captured === options.victimType,
      `played capture lost its victim type in game ${game}:${ply}`);

    if (rng.next() < 0.58) {
      const home = options.homes[rng.int(options.homes.length)];
      const expected = direct.resurrect({ from: chosen.from, to: chosen.to, promotion: chosen.promotion, home });
      const event = match.takeHomecoming(home);
      homecomings++;
      assert(event.undone?.kind === 'move', `rollback did not return the visible move in ${game}:${ply}`);
      assert(match.pendingResurrection() === null, `offer survived its homecoming in ${game}:${ply}`);
      assert(identity(match) === identity(direct),
        `deferred homecoming drifted from direct resurrection in ${game}:${ply}\n` +
        `before=${before}\nactual=${identity(match)}\nexpected=${identity(direct)}`);
      assert(event.fenAfter === expected.fenAfter, `event FEN disagreed in ${game}:${ply}`);
    } else {
      match.keepCapture();
      keeps++;
      assert(match.pendingResurrection() === null, `offer survived Keep it in ${game}:${ply}`);
      const replayed = replayMatch(match.seed, match.serializedActions());
      assert(identity(match) === identity(replayed), `kept capture failed replay in ${game}:${ply}`);
    }
  }

  const replayed = replayMatch(match.seed, match.serializedActions());
  assert(identity(match) === identity(replayed), `final lifecycle replay drifted in game ${game}`);
}

{
  // A pending decision is a turn boundary. The UI disables the board, but the
  // rule core needs the same guard so a late click, stale handler, or future
  // caller cannot play Black's reply before White chooses Keep/Undo.
  const match = new ExchangeMatch('pending-guard');
  match.chess.load('3q3k/8/3R4/8/8/8/8/4K3 w - - 4 30');
  match.origins.clear();
  match.origins.set('d8', { home: 'd8' });
  match.origins.set('h8', { home: 'e8' });
  match.origins.set('d6', { home: 'a1' });
  match.origins.set('e1', { home: 'e1' });
  match.dead.w.push({ type: 'q', homes: ['d1'] });

  match.applyMove({ from: 'd6', to: 'd8' });
  const before = identity(match);
  expectThrow(
    () => match.takeHomecoming('a1'),
    /no dead .* can return/i,
    'an unavailable home square was accepted',
  );
  assert(identity(match) === before, 'an invalid home choice mutated the pending exchange');

  const blackReply = match.legalMoves()[0];
  expectThrow(
    () => match.applyMove({ from: blackReply.from, to: blackReply.to, promotion: blackReply.promotion }),
    /homecoming decision/i,
    'a second move was allowed while the capture decision was pending',
  );
  assert(identity(match) === before, 'a rejected stale move mutated the pending exchange');

  expectThrow(
    () => match.resurrect({ from: blackReply.from, to: blackReply.to, home: 'd1' }),
    /homecoming decision/i,
    'a direct resurrection cleared the pending decision',
  );
  assert(identity(match) === before, 'an invalid resurrection mutated the pending exchange');
  ok('a pending homecoming is an atomic decision: stale moves cannot pass through it');
}

{
  // In ordinary chess, swapping two white knights is invisible to threefold
  // repetition. Here it matters: the knight that began on b1 can only return
  // to b1, while the g1 knight is owed g1. A board that looks identical after
  // the two knights swap is a different Prisoner Exchange position and must
  // not draw early.
  const match = new ExchangeMatch('identity-repetition');
  match.chess.load('n3k3/8/8/8/8/8/8/1N2K1N1 w - - 0 1');
  match.origins.clear();
  match.origins.set('a8', { home: 'b8' });
  match.origins.set('e8', { home: 'e8' });
  match.origins.set('b1', { home: 'b1' });
  match.origins.set('e1', { home: 'e1' });
  match.origins.set('g1', { home: 'g1' });
  match.positionCounts.clear();
  match.repetitionDraw = false;

  const swapCycle = [
    ['b1', 'c3'], ['a8', 'b6'],
    ['g1', 'f3'], ['b6', 'a8'],
    ['c3', 'e2'], ['a8', 'b6'],
    ['f3', 'd2'], ['b6', 'a8'],
    ['e2', 'g1'], ['a8', 'b6'],
    ['d2', 'b1'], ['b6', 'a8'],
  ];
  const playCycle = () => {
    for (const [from, to] of swapCycle) {
      if (match.status().over) return;
      match.applyMove({ from, to });
      match.keepCapture();
    }
  };

  // After four visual repetitions, each true origin-aware state has appeared
  // only twice. The old board-only key declared a threefold draw already.
  playCycle();
  playCycle();
  playCycle();
  playCycle();
  assert(!match.status().over, 'knight identities were ignored and caused a false threefold draw');

  // On the fifth swap-cycle one of the two origin-aware positions truly has
  // occurred three times, so the normal draw rule now applies.
  playCycle();
  const status = match.status();
  assert(status.over && status.reason === 'threefold repetition',
    `origin-aware repetition did not eventually draw: ${JSON.stringify(status)}`);
  ok('threefold repetition distinguishes identical pieces with different home rights');
}

console.log(`  lifecycle: ${GAMES} games, ${offers} offers, ${homecomings} homecomings, ${keeps} kept captures`);
ok('deferred capture decisions preserve board, graveyard, identity, replay, and turn invariants');
summary('exchange-lifecycle.test.mjs');
