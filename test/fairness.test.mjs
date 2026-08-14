// Two promises the game makes about Magic, checked as claims rather than hopes:
//   1. Checkmate (and every other ending) is final. No teleport follows it.
//   2. The draw is uniform. Every eligible piece is equally likely, and for the
//      chosen piece every eligible empty square is equally likely. Magic is not
//      nudging material off the board or favouring either colour.
import { Chess } from '../js/vendor/chess.js';
import { ChaosMatch } from '../js/core/chaos.js';
import { runTeleportPhase, validTeleportDests, countPieces, magicIsActive, MAGIC_STOPS_AT } from '../js/core/teleport.js';
import { makeRng, seedFromString } from '../js/core/rng.js';
import { assert, ok, summary } from './helpers.mjs';

/* ---------- 1. endings are final ---------- */

// Scholar's mate: the mating move must end the game with no teleport at all.
{
  const mate = new ChaosMatch('mate-final');
  mate.chess = new Chess('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
  const move = mate.applyMove({ from: 'h5', to: 'f7' });
  assert(move.san.includes('#'), `expected a mating move, got ${move.san}`);
  const status = mate.status();
  assert(status.over && status.reason === 'checkmate', 'position should be checkmate');
  const events = mate.teleportIfDue();
  assert(Array.isArray(events) && events.length === 0, `checkmate must not be followed by a teleport, got ${JSON.stringify(events)}`);
  assert(mate.status().reason === 'checkmate', 'checkmate must survive the teleport phase');
  assert(mate.log.filter((e) => e.kind === 'teleport').length === 0, 'no teleport may be logged after mate');
  assert(mate.log.at(-1).san.includes('#'), 'the logged move should keep its # now that mate is final');
  ok('checkmate ends the game with no teleport and keeps its # in the log');
}

// Stalemate is equally final.
{
  const m = new ChaosMatch('stale-final');
  m.chess = new Chess('7k/5Q2/8/8/8/8/8/K7 w - - 0 1');
  m.applyMove({ from: 'f7', to: 'g6' }); // Qg6 = stalemate, black king h8 has no move
  const status = m.status();
  assert(status.over && status.reason === 'stalemate', `expected stalemate, got ${status.reason}`);
  const events = m.teleportIfDue();
  assert(events.length === 0, 'stalemate must not be followed by a teleport');
  ok('stalemate ends the game with no teleport');
}

// An ordinary move still owes its teleport.
{
  const m = new ChaosMatch('normal-owes');
  m.applyMove({ from: 'e2', to: 'e4' });
  assert(!m.status().over, 'game should still be running');
  const events = m.teleportIfDue();
  assert(events.length === 1, `a live game still teleports, got ${events.length}`);
  ok('a live game still teleports after every move');
}

/* ---------- 2. the draw is uniform ---------- */

// Every eligible piece should come up about equally often.
{
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const probe = new Chess(fen);
  const eligible = [];
  for (const row of probe.board()) {
    for (const cell of row) {
      if (cell && cell.color === 'w' && cell.type !== 'k' && validTeleportDests(probe, cell.square).length) {
        eligible.push(cell.square);
      }
    }
  }
  const TRIALS = 24000;
  const counts = new Map(eligible.map((sq) => [sq, 0]));
  for (let i = 0; i < TRIALS; i++) {
    const board = new Chess(fen);
    const [event] = runTeleportPhase(board, makeRng(seedFromString(`piece-${i}`)), 'w');
    assert(event, 'expected a teleport');
    assert(counts.has(event.from), `picked an ineligible piece ${event.from}`);
    counts.set(event.from, counts.get(event.from) + 1);
  }
  const expected = TRIALS / eligible.length;
  let worst = 0;
  for (const [, n] of counts) worst = Math.max(worst, Math.abs(n - expected) / expected);
  console.log(`  piece draw: ${eligible.length} eligible, expected ${Math.round(expected)} each, worst deviation ${(worst * 100).toFixed(1)}%`);
  assert(worst < 0.15, `piece choice is biased: worst deviation ${(worst * 100).toFixed(1)}%`);
  ok(`every eligible piece is drawn about equally (${eligible.length} candidates)`);
}

// For one chosen piece, every eligible destination should come up about equally.
{
  const fen = '4k3/8/8/8/8/8/4P3/4K3 b - - 0 1'; // one white pawn, many squares
  const probe = new Chess(fen);
  const dests = validTeleportDests(probe, 'e2');
  assert(dests.length > 20, `expected a wide destination set, got ${dests.length}`);
  const TRIALS = 24000;
  const counts = new Map(dests.map((sq) => [sq, 0]));
  for (let i = 0; i < TRIALS; i++) {
    const board = new Chess(fen);
    // stopsAt 0 keeps Magic switched on regardless of piece count, isolating
    // the destination draw from the stop rule that is tested separately below.
    const [event] = runTeleportPhase(board, makeRng(seedFromString(`dest-${i}`)), 'w', { stopsAt: 0 });
    assert(event.from === 'e2', 'only the pawn can move here');
    assert(counts.has(event.to), `landed on an ineligible square ${event.to}`);
    counts.set(event.to, counts.get(event.to) + 1);
  }
  const expected = TRIALS / dests.length;
  let worst = 0;
  for (const [, n] of counts) worst = Math.max(worst, Math.abs(n - expected) / expected);
  console.log(`  destination draw: ${dests.length} squares, expected ${Math.round(expected)} each, worst deviation ${(worst * 100).toFixed(1)}%`);
  assert(worst < 0.2, `destination choice is biased: worst deviation ${(worst * 100).toFixed(1)}%`);
  ok(`every eligible destination is drawn about equally (${dests.length} squares)`);
}

// Magic must not prefer one colour: over many games each side is teleported the
// same number of times, because each side teleports exactly once per own move.
{
  let white = 0;
  let black = 0;
  for (let g = 0; g < 40; g++) {
    const m = new ChaosMatch(`colour-${g}`);
    const mover = makeRng(seedFromString(`colour-mover-${g}`));
    for (let step = 0; step < 40; step++) {
      if (m.status().over) break;
      const moves = m.legalMoves();
      const mv = moves[mover.int(moves.length)];
      m.applyMove({ from: mv.from, to: mv.to, promotion: mv.promotion });
      for (const ev of m.teleportIfDue() || []) {
        ev.piece.color === 'w' ? white++ : black++;
      }
    }
  }
  const skew = Math.abs(white - black) / (white + black);
  console.log(`  colour balance: white ${white}, black ${black}, skew ${(skew * 100).toFixed(1)}%`);
  assert(skew < 0.05, `Magic favours a colour: white ${white} vs black ${black}`);
  ok('Magic teleports both colours equally often');
}

// Magic must not preferentially strand valuable pieces: piece types are drawn in
// proportion to how many of them are on the board, nothing more.
{
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';
  const TRIALS = 16000;
  const byType = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (let i = 0; i < TRIALS; i++) {
    const board = new Chess(fen);
    const [event] = runTeleportPhase(board, makeRng(seedFromString(`type-${i}`)), 'w');
    if (event) byType[event.piece.type]++;
  }
  // From the start position only the knights and the pawns have anywhere to go,
  // so the draw should split by how many of those pieces are actually eligible.
  const probe = new Chess(fen);
  const eligibleByType = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const row of probe.board()) {
    for (const cell of row) {
      if (cell && cell.color === 'w' && cell.type !== 'k' && validTeleportDests(probe, cell.square).length) {
        eligibleByType[cell.type]++;
      }
    }
  }
  const totalEligible = Object.values(eligibleByType).reduce((a, b) => a + b, 0);
  for (const [type, count] of Object.entries(byType)) {
    const expected = TRIALS * (eligibleByType[type] / totalEligible);
    if (!eligibleByType[type]) {
      assert(count === 0, `${type} was drawn ${count} times despite having no legal destination`);
      continue;
    }
    const dev = Math.abs(count - expected) / expected;
    assert(dev < 0.15, `${type} drawn ${count}, expected about ${Math.round(expected)}`);
  }
  console.log(`  type draw: ${JSON.stringify(byType)} against eligible ${JSON.stringify(eligibleByType)}`);
  ok('piece types are drawn in proportion to how many are eligible, with no value weighting');
}

/* ---------- 3. WHEN Magic acts is a hard rule, never a dice roll ---------- */

// Above the line it must act every single time; at or below it, never. No
// randomness in the timing at all, or the rule is unpredictable in play.
{
  const above = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1'; // 32
  const TRIALS = 3000;
  let acted = 0;
  for (let i = 0; i < TRIALS; i++) {
    const board = new Chess(above);
    if (runTeleportPhase(board, makeRng(seedFromString(`above-${i}`)), 'w').length) acted++;
  }
  assert(acted === TRIALS, `Magic must act every turn above the line, acted ${acted}/${TRIALS}`);

  // Exactly one piece over the line: still every single time.
  const edge = '4k3/8/8/8/8/P7/PPPPPPPP/4K3 b - - 0 1'; // 2 kings + 9 pawns = 11
  const edgeBoard = new Chess(edge);
  assert(countPieces(edgeBoard) === MAGIC_STOPS_AT + 1, `edge fen has ${countPieces(edgeBoard)} pieces, want ${MAGIC_STOPS_AT + 1}`);
  let edgeActed = 0;
  for (let i = 0; i < TRIALS; i++) {
    const board = new Chess(edge);
    if (runTeleportPhase(board, makeRng(seedFromString(`edge-${i}`)), 'w').length) edgeActed++;
  }
  assert(edgeActed === TRIALS, `one piece above the line must still always act, acted ${edgeActed}/${TRIALS}`);
  ok(`Magic acts on every single turn while more than ${MAGIC_STOPS_AT} pieces remain`);
}

{
  // At the line and below: never, no matter the seed or how many pieces the
  // mover still owns.
  const TRIALS = 3000;
  for (const [label, fen] of [
    ['exactly at the line', '4k3/8/8/8/8/8/PPPPPPPP/4K3 b - - 0 1'], // 2 kings + 8 pawns = 10
    ['deep endgame', '4k3/8/8/8/8/8/8/3QK3 b - - 0 1'],
  ]) {
    const board0 = new Chess(fen);
    assert(countPieces(board0) <= MAGIC_STOPS_AT, `${label} has ${countPieces(board0)} pieces, expected <= ${MAGIC_STOPS_AT}`);
    let acted = 0;
    for (let i = 0; i < TRIALS; i++) {
      const board = new Chess(fen);
      if (runTeleportPhase(board, makeRng(seedFromString(`below-${label}-${i}`)), 'w').length) acted++;
    }
    assert(acted === 0, `${label}: Magic acted ${acted}/${TRIALS} times below the line`);
    assert(!magicIsActive(board0), `${label} should report Magic inactive`);
  }
  ok(`Magic never acts once ${MAGIC_STOPS_AT} or fewer pieces remain`);
}

// The property that makes it a real rule rather than a mood: once it stops it
// can never start again, because the piece count never goes up.
{
  let stopsSeen = 0;
  let restarts = 0;
  for (let g = 0; g < 60; g++) {
    const m = new ChaosMatch(`monotone-${g}`);
    const mover = makeRng(seedFromString(`monotone-mover-${g}`));
    let everStopped = false;
    let lastCount = Infinity;
    for (let step = 0; step < 160; step++) {
      if (m.status().over) break;
      const moves = m.legalMoves();
      const mv = moves[mover.int(moves.length)];
      m.applyMove({ from: mv.from, to: mv.to, promotion: mv.promotion });
      const events = m.teleportIfDue() || [];
      const f = m.magicState();
      // piece count must never increase, which is what makes the stop final
      assert(f.onBoard <= lastCount, `piece count rose from ${lastCount} to ${f.onBoard} g${g} s${step}`);
      lastCount = f.onBoard;
      if (!f.active) { if (!everStopped) stopsSeen++; everStopped = true; }
      if (everStopped && events.length) restarts++;
    }
  }
  console.log(`  games that reached the stop: ${stopsSeen}/60, restarts after stopping: ${restarts}`);
  assert(stopsSeen > 0, 'no game reached the stop, so the rule was never exercised');
  assert(restarts === 0, `Magic restarted after stopping ${restarts} times`);
  ok('once Magic stops it never acts again for the rest of the game');
}

summary('fairness.test.mjs');
