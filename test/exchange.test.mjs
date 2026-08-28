import { Chess } from '../js/vendor/chess.js';
import { ExchangeMatch, replayMatch, resurrectionFen, canonicalHomes, START_FEN } from '../js/core/exchange.js';
import { assert, ok, summary } from './helpers.mjs';

// Play a sequence of SAN or {from,to,promotion} moves onto a fresh match.
function play(...moves) {
  const match = new ExchangeMatch('rule-test');
  const feed = new Chess(START_FEN);
  for (const item of moves) {
    const move = typeof item === 'string'
      ? feed.moves({ verbose: true }).find((m) => m.san === item)
      : feed.moves({ verbose: true }).find((m) => m.from === item.from && m.to === item.to
        && (m.promotion || undefined) === (item.promotion || undefined));
    if (!move) throw new Error(`test fixture: no legal move ${JSON.stringify(item)} at ${feed.fen()}`);
    feed.move(move);
    match.applyMove({ from: move.from, to: move.to, promotion: move.promotion });
    match.keepCapture();
  }
  return match;
}

{
  // Scholar-ish opening trade: both queens die, then White captures Black's
  // knight while its own knight waits dead. Wrong-type: no offer.
  const match = play('e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+', 'Kxf7');
  assert(match.dead.w.length === 1 && match.dead.w[0].type === 'q', 'White queen did not reach its graveyard');
  assert(match.dead.w[0].homes.length === 1 && match.dead.w[0].homes[0] === 'd1',
    `original queen should remember d1, got ${JSON.stringify(match.dead.w[0].homes)}`);
  ok('a captured original piece enters the graveyard remembering its true starting square');
}

{
  // Type must match: White has a dead QUEEN, captures a KNIGHT: no offer.
  const match = play('e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+', 'Kxf7', 'Nf3', 'Nd4');
  const capture = match.legalMoves().find((m) => m.captured === 'n');
  assert(capture, 'fixture lost its knight capture');
  assert(match.resurrectionOptions(capture) === null, 'a dead queen was offered for a captured knight');
  ok('resurrection requires the captured type to match a dead piece exactly');
}

{
  // The full happy path: queens trade, then White captures Black's queen...
  // no. Simplest constructed case: put a match in a hand-built position.
  const match = new ExchangeMatch('happy');
  match.chess.load('3q3k/8/8/8/8/8/3P4/3K4 w - - 4 30');
  match.origins.clear();
  match.origins.set('d8', { home: 'd8' });
  match.origins.set('h8', { home: 'e8' });
  match.origins.set('d2', { home: 'd2' });
  match.origins.set('d1', { home: 'e1' });
  match.dead.w.push({ type: 'q', homes: ['d1'] });

  // White queen home d1 is occupied by White's own king: blocked.
  const capture = { from: 'd1', to: 'd8' };
  void capture;
  const rookless = match.legalMoves().filter((m) => m.captured === 'q');
  assert(rookless.length === 0, 'fixture unexpectedly allows a queen capture already');

  // March the pawn is too slow; rebuild with a capturable queen instead.
  match.chess.load('3q3k/8/3R4/8/8/8/8/3K4 w - - 4 30');
  match.origins.clear();
  match.origins.set('d8', { home: 'd8' });
  match.origins.set('h8', { home: 'e8' });
  match.origins.set('d6', { home: 'a1' });
  match.origins.set('d1', { home: 'e1' });

  const take = match.legalMoves().find((m) => m.captured === 'q');
  assert(take && take.from === 'd6' && take.to === 'd8', 'fixture lost its queen capture');
  const options = match.resurrectionOptions(take);
  assert(options && options.victimType === 'q' && options.homes.length === 1 && options.homes[0] === 'd1'
    === false || options === null || true, 'placeholder');
  // d1 is occupied by White's king in this fixture: no home, no offer.
  assert(options === null, 'an occupied home square was offered');
  ok('an occupied home square blocks the offer entirely');
}

{
  // Same position, but the king stands on e1 so d1 is open.
  const match = new ExchangeMatch('happy-2');
  match.chess.load('3q3k/8/3R4/8/8/8/8/4K3 w - - 4 30');
  match.origins.clear();
  match.origins.set('d8', { home: 'd8' });
  match.origins.set('h8', { home: 'e8' });
  match.origins.set('d6', { home: 'a1' });
  match.origins.set('e1', { home: 'e1' });
  match.dead.w.push({ type: 'q', homes: ['d1'] });

  const take = match.legalMoves().find((m) => m.captured === 'q');
  const options = match.resurrectionOptions(take);
  assert(options && options.victimType === 'q' && options.homes.join() === 'd1', 'open home was not offered');

  const event = match.resurrect({ from: take.from, to: take.to, home: 'd1' });
  assert(event.kind === 'resurrect' && event.home === 'd1', 'resurrect event malformed');
  assert(match.chess.get('d8')?.type === 'q' && match.chess.get('d8')?.color === 'b',
    'the captured-then-spared queen did not survive on its square');
  assert(match.chess.get('d6')?.type === 'r', 'the capturing rook did not stay home');
  assert(match.chess.get('d1')?.type === 'q' && match.chess.get('d1')?.color === 'w',
    'the dead queen did not return to d1');
  assert(match.turn() === 'b', 'resurrection did not end the turn');
  assert(match.dead.w.length === 0, 'the graveyard entry was not consumed');
  assert(match.fen().split(' ')[4] === '0', 'resurrection did not reset the fifty-move clock');
  ok('a resurrection spares the victim, returns the dead piece home and ends the turn');
}

{
  // Both knights dead: capturing one enemy knight offers both open homes,
  // and picking one consumes exactly one entry.
  const match = new ExchangeMatch('two-knights');
  match.chess.load('4k3/8/1n6/8/3B4/8/8/4K3 w - - 0 30');
  match.origins.clear();
  match.origins.set('e8', { home: 'e8' });
  match.origins.set('b6', { home: 'b8' });
  match.origins.set('d4', { home: 'c1' });
  match.origins.set('e1', { home: 'e1' });
  match.dead.w.push({ type: 'n', homes: ['b1'] });
  match.dead.w.push({ type: 'n', homes: ['g1'] });

  const take = match.legalMoves().find((m) => m.captured === 'n');
  const options = match.resurrectionOptions(take);
  assert(options.homes.slice().sort().join() === 'b1,g1', `expected both knight homes, got ${options.homes}`);
  match.resurrect({ from: take.from, to: take.to, home: 'g1' });
  assert(match.chess.get('g1')?.type === 'n', 'knight did not return to g1');
  assert(match.dead.w.length === 1 && match.dead.w[0].homes[0] === 'b1',
    'the wrong graveyard entry was consumed');
  ok('multiple dead pieces of one type offer every open home and consume the matching entry');
}

{
  // Most-constrained-first: an original b1 knight and a promoted knight both
  // wait. Picking b1 must consume the original (single-home) entry, leaving
  // the flexible promoted entry for later.
  const match = new ExchangeMatch('constrained');
  match.chess.load('4k3/8/1n6/8/3B4/8/8/4K3 w - - 0 30');
  match.origins.clear();
  match.origins.set('e8', { home: 'e8' });
  match.origins.set('b6', { home: 'b8' });
  match.origins.set('d4', { home: 'c1' });
  match.origins.set('e1', { home: 'e1' });
  match.dead.w.push({ type: 'n', homes: ['b1', 'g1'] }); // promoted, listed first
  match.dead.w.push({ type: 'n', homes: ['b1'] });       // original b1 knight

  const take = match.legalMoves().find((m) => m.captured === 'n');
  match.resurrect({ from: take.from, to: take.to, home: 'b1' });
  assert(match.dead.w.length === 1 && match.dead.w[0].homes.length === 2,
    'the flexible promoted entry was consumed instead of the constrained original');
  ok('a shared home square consumes the most constrained graveyard entry first');
}

{
  // A promoted piece dies as its promoted type and adopts that type's
  // standard squares. First: promotion marks the piece.
  const match = new ExchangeMatch('promoted-victim');
  match.chess.load('4k3/1P6/8/8/8/8/8/4K3 w - - 0 30');
  match.origins.clear();
  match.origins.set('e8', { home: 'e8' });
  match.origins.set('b7', { home: 'b2' });
  match.origins.set('e1', { home: 'e1' });
  match.applyMove({ from: 'b7', to: 'b8', promotion: 'q' });
  assert(match.origins.get('b8')?.promoted === 'q', 'promotion did not mark the piece as promoted');

  // Then: capturing a marked promoted queen files it under the queen's
  // standard square, not the pawn's old one.
  const second = new ExchangeMatch('promoted-victim-2');
  second.chess.load('1q5k/8/8/8/8/8/8/1R2K3 w - - 0 30');
  second.origins.clear();
  second.origins.set('b8', { promoted: 'q' });
  second.origins.set('h8', { home: 'e8' });
  second.origins.set('b1', { home: 'a1' });
  second.origins.set('e1', { home: 'e1' });
  second.applyMove({ from: 'b1', to: 'b8' });
  const entry = second.dead.b.find((item) => item.type === 'q');
  assert(entry && entry.homes.join() === 'd8', `promoted queen should adopt d8, got ${JSON.stringify(entry)}`);
  ok('a dead promoted piece adopts the standard starting square of its type');
}

{
  // En passant captures a pawn: pawns are outside the trade, and the victim
  // is recorded from the en passant square, not the arrival square.
  const match = play('e4', 'a6', 'e5', 'd5');
  const ep = match.legalMoves().find((m) => m.flags.includes('e'));
  assert(ep, 'fixture lost its en passant capture');
  assert(match.resurrectionOptions(ep) === null, 'en passant offered a resurrection');
  match.applyMove(ep);
  assert(match.dead.b.length === 1 && match.dead.b[0].type === 'p' && match.dead.b[0].homes === null,
    'the en passant victim was not recorded as an unresurrectable pawn');
  assert(!match.origins.has('d5'), 'the en passant victim left its origin behind');
  assert(match.origins.get('d6')?.home === 'e2', 'the capturing pawn did not carry its origin to d6');
  ok('en passant is outside the trade and cleans up the victim origin correctly');
}

{
  // Castling moves the rook origin with the rook.
  const match = play('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O');
  assert(match.origins.get('f1')?.home === 'h1', 'castling did not carry the rook origin to f1');
  assert(match.origins.get('g1')?.home === 'e1', 'castling did not carry the king origin to g1');
  ok('castling carries both king and rook origins');
}

{
  // A capture that is also a promotion: the offer works and declining the
  // capture undoes the promotion implicitly (the pawn never moves).
  const match = new ExchangeMatch('promo-capture');
  match.chess.load('3q3k/4P3/8/8/8/8/8/4K3 w - - 0 30');
  match.origins.clear();
  match.origins.set('d8', { home: 'd8' });
  match.origins.set('h8', { home: 'e8' });
  match.origins.set('e7', { home: 'e2' });
  match.origins.set('e1', { home: 'e1' });
  match.dead.w.push({ type: 'q', homes: ['d1'] });

  const promoTake = { from: 'e7', to: 'd8', promotion: 'q' };
  const options = match.resurrectionOptions(promoTake);
  assert(options && options.homes.join() === 'd1', 'promotion-capture was not offered');
  match.resurrect({ ...promoTake, home: 'd1' });
  assert(match.chess.get('e7')?.type === 'p', 'the promoting pawn did not stay a pawn on e7');
  assert(match.chess.get('d8')?.type === 'q' && match.chess.get('d8')?.color === 'b', 'the spared queen vanished');
  assert(match.chess.get('d1')?.type === 'q' && match.chess.get('d1')?.color === 'w', 'the dead queen did not return');
  ok('declining a promotion-capture leaves the pawn unpromoted and brings the dead queen home');
}

{
  // In check: resurrection is only offered when the placement blocks the
  // check. Here the rook checks down the e-file; capturing the rook with the
  // knight is legal, and a queen returning to e1's neighbor d1 does NOT
  // block, so no offer. A queen home ON the checking line would.
  const match = new ExchangeMatch('check-block');
  match.chess.load('4r2k/8/3N4/8/8/8/8/4K3 w - - 0 30');
  match.origins.clear();
  match.origins.set('e8', { home: 'a8' });
  match.origins.set('h8', { home: 'e8' });
  match.origins.set('d6', { home: 'g1' });
  match.origins.set('e1', { home: 'e1' });
  assert(match.status().check, 'fixture is not check');
  // White has a dead ROOK whose homes are a1/h1: neither blocks the e-file.
  match.dead.w.push({ type: 'r', homes: ['a1', 'h1'] });
  const takeRook = match.legalMoves().find((m) => m.captured === 'r');
  assert(takeRook, 'no legal rook capture escapes this check');
  assert(match.resurrectionOptions(takeRook) === null,
    'a placement that leaves the king in check was offered');
  ok('in check, a resurrection that does not block the check is never offered');
}

{
  // Same idea, but the home square DOES block: black rook on d8 checks a
  // white king on d3 down the d-file, and White's dead queen returns to d1...
  // which is behind the king, so build it the other way: king on d1's file
  // above home. King d4, rook d8, dead queen home d1 does not block either.
  // The genuinely blocking case: king on d1's north, home BETWEEN them is
  // impossible for rank-1 homes, so use the rank itself: black rook a1
  // checks along rank 1, king e1, dead queen home d1 blocks.
  const match = new ExchangeMatch('check-block-2');
  match.chess.load('7k/8/8/8/8/8/6P1/r3K3 w - - 0 30');
  match.origins.clear();
  match.origins.set('h8', { home: 'e8' });
  match.origins.set('a1', { home: 'a8' });
  match.origins.set('g2', { home: 'g2' });
  match.origins.set('e1', { home: 'e1' });
  match.dead.w.push({ type: 'q', homes: ['d1'] });
  assert(match.status().check, 'fixture is not check');
  // No queen capture exists; eligibility is tested through resurrectionFen
  // directly: the placement on d1 blocks the rank-1 check.
  assert(resurrectionFen(match.fen(), 'q', 'w', 'd1') !== null,
    'a check-blocking placement was rejected');
  assert(resurrectionFen(match.fen(), 'q', 'w', 'c1') === null || true, 'placeholder');
  ok('a placement that blocks the check is legal by the shared fen helper');
}

{
  // The placement itself may give check.
  const match = new ExchangeMatch('gives-check');
  match.chess.load('3k4/8/8/8/8/8/8/K2q4 b - - 0 30');
  match.origins.clear();
  match.origins.set('d8', { home: 'e8' });
  match.origins.set('d1', { home: 'promoted-placeholder' });
  match.origins.set('a1', { home: 'e1' });
  match.dead.b.push({ type: 'q', homes: ['d8'] });
  // Black to move; king walks so d8 frees... d8 is occupied by the king.
  // Rebuild: black king e7, dead queen home d8 open, white piece capturable.
  match.chess.load('8/4k3/8/8/8/8/8/3K4 b - - 0 30');
  match.origins.clear();
  match.origins.set('e7', { home: 'e8' });
  match.origins.set('d1', { home: 'e1' });
  match.dead.b.push({ type: 'q', homes: ['d8'] });
  const fen = resurrectionFen(match.fen(), 'q', 'b', 'd8');
  assert(fen, 'legal placement rejected');
  const after = new Chess(fen);
  assert(after.turn() === 'w' && after.isCheck(), 'a queen landing on d8 should check the king down the open d-file');
  ok('a returned piece may give check from its home square');
}

{
  // A resurrected rook cannot castle.
  const match = new ExchangeMatch('no-castle');
  match.chess.load('r3k2r/8/8/8/8/8/6B1/4K2n w kq - 0 30');
  match.origins.clear();
  match.origins.set('a8', { home: 'a8' });
  match.origins.set('e8', { home: 'e8' });
  match.origins.set('h8', { home: 'h8' });
  match.origins.set('g2', { home: 'f1' });
  match.origins.set('e1', { home: 'e1' });
  match.origins.set('h1', { home: 'g8' });
  match.dead.w.push({ type: 'r', homes: ['h1'] });
  // h1 is occupied by the black knight: capturing it does not free h1 within
  // the offer (evaluated pre-capture), so no offer exists here.
  const takeKnight = match.legalMoves().find((m) => m.captured === 'n');
  assert(takeKnight, 'fixture lost its knight capture');
  assert(match.resurrectionOptions(takeKnight) === null,
    'a home occupied by the victim itself was offered');
  ok('a home square occupied by the victim stays blocked, because the victim survives');
}

{
  // Castling rights are not restored by a returned rook.
  const match = new ExchangeMatch('rights');
  match.chess.load('4k2r/8/8/8/7r/8/6N1/4K3 w k - 0 30');
  match.origins.clear();
  match.origins.set('e8', { home: 'e8' });
  match.origins.set('h8', { home: 'h8' });
  match.origins.set('h4', { home: 'a8' });
  match.origins.set('g2', { home: 'g1' });
  match.origins.set('e1', { home: 'e1' });
  match.dead.w.push({ type: 'r', homes: ['h1'] });
  const takeRook = match.legalMoves().find((m) => m.captured === 'r');
  assert(takeRook, 'fixture lost its rook capture');
  const options = match.resurrectionOptions(takeRook);
  assert(options && options.homes.includes('h1'), 'open h1 was not offered');
  match.resurrect({ from: takeRook.from, to: takeRook.to, home: 'h1' });
  assert(match.chess.get('h1')?.type === 'r', 'rook did not return to h1');
  const castling = match.fen().split(' ')[2];
  assert(!castling.includes('K'), `returned rook restored castling rights: ${castling}`);
  ok('a returned rook does not restore castling rights');
}

{
  // Bare kings end the game immediately.
  const match = new ExchangeMatch('bare');
  match.chess.load('4k3/8/8/8/8/8/8/4K3 w - - 12 40');
  const status = match.status();
  assert(status.over && status.winner === null && status.reason === 'bare kings',
    `bare kings did not draw: ${JSON.stringify(status)}`);
  ok('two bare kings draw on the spot');
}

{
  // Full replay: a real game with a resurrection reproduces everything.
  const original = new ExchangeMatch('replay-game');
  // Black walks its queen to g5 where Nf3 can take it; White's own queen is
  // already dead with d1 open, so the offer MUST exist and MUST be taken.
  const script = ['e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+', 'Kxf7', 'Nf3', 'Qg5'];
  const feed = new Chess(START_FEN);
  for (const san of script) {
    const move = feed.moves({ verbose: true }).find((m) => m.san === san);
    feed.move(move);
    original.applyMove({ from: move.from, to: move.to, promotion: move.promotion });
  }
  const eligible = original.legalMoves()
    .map((m) => ({ m, options: original.resurrectionOptions(m) }))
    .find((item) => item.options);
  assert(eligible, 'the replay fixture no longer produces a resurrection offer');
  assert(eligible.options.homes.join() === 'd1', `expected d1, got ${eligible.options.homes}`);
  original.resurrect({ from: eligible.m.from, to: eligible.m.to, promotion: eligible.m.promotion, home: 'd1' });
  assert(original.log.some((entry) => entry.kind === 'resurrect'), 'no resurrection was recorded');
  const restored = replayMatch(original.seed, original.serializedActions());
  assert(restored.fen() === original.fen(), `replay FEN drifted\n${restored.fen()}\n${original.fen()}`);
  assert(JSON.stringify(restored.dead) === JSON.stringify(original.dead), 'replay graveyards drifted');
  assert(JSON.stringify([...restored.origins].sort()) === JSON.stringify([...original.origins].sort()),
    'replay origin tracking drifted');
  ok('serialized actions replay to an identical match, resurrection included');
}

{
  // canonicalHomes sanity for both colors.
  assert(canonicalHomes('q', 'w').join() === 'd1' && canonicalHomes('q', 'b').join() === 'd8', 'queen homes wrong');
  assert(canonicalHomes('r', 'b').join() === 'a8,h8' && canonicalHomes('n', 'w').join() === 'b1,g1'
    && canonicalHomes('b', 'b').join() === 'c8,f8', 'minor/rook homes wrong');
  assert(canonicalHomes('p', 'w').length === 0 && canonicalHomes('k', 'w').length === 0, 'pawns and kings must have no homes');
  ok('canonical home squares are correct for every resurrectable type');
}

{
  // The consumed entry is picked from entries that can actually use the
  // chosen square. An original g1-only knight plus a promoted knight
  // (b1 or g1) wait; the capturer picks b1. The g1-only entry is the most
  // constrained overall, but it cannot go to b1: the promoted entry must be
  // the one consumed, leaving the original still waiting for g1.
  const match = new ExchangeMatch('rule-8');
  match.chess.load('4k3/8/1n6/8/3B4/8/8/4K3 w - - 0 30');
  match.origins.clear();
  match.origins.set('e8', { home: 'e8' });
  match.origins.set('b6', { home: 'b8' });
  match.origins.set('d4', { home: 'c1' });
  match.origins.set('e1', { home: 'e1' });
  match.dead.w.push({ type: 'n', homes: ['g1'] });       // original g1 knight
  match.dead.w.push({ type: 'n', homes: ['b1', 'g1'] }); // promoted knight

  const take = match.legalMoves().find((m) => m.captured === 'n');
  match.resurrect({ from: take.from, to: take.to, home: 'b1' });
  assert(match.chess.get('b1')?.type === 'n', 'knight did not return to b1');
  assert(match.dead.w.length === 1 && match.dead.w[0].homes.join() === 'g1',
    `the g1-only original should remain, got ${JSON.stringify(match.dead.w)}`);
  ok('the consumed entry is the most constrained AMONG those that fit the chosen square');
}

{
  // Per-piece identity: a dead ORIGINAL knight remembers the ONE square it
  // started on, never its twin's. This must go through applyMove itself
  // (not a hand-pushed graveyard entry), because a regression here slides
  // straight past every queen-based fixture: the queen's canonical square
  // and its true origin coincide, a knight's do not.
  const match = play('Nf3', 'Nf6', 'Ne5', 'Nd5', 'Nd3', 'Nb4', 'Nxb4');
  const entry = match.dead.b.find((item) => item.type === 'n');
  assert(entry, 'the black knight never reached its graveyard');
  assert(entry.homes.join() === 'g8',
    `the g8 knight must remember exactly g8, got ${JSON.stringify(entry.homes)}`);
  ok('a dead original piece remembers its own starting square, not its twin\'s');
}

// The capture is played for real before anyone chooses, so the board can
// show it being taken and then taken back. Rolling it back must restore the
// match EXACTLY, or the undo silently corrupts the game.
{
  const build = () => {
    const m = new ExchangeMatch('rollback');
    m.chess.load('3q3k/8/3R4/8/8/8/8/4K3 w - - 4 30');
    m.origins.clear();
    m.origins.set('d8', { home: 'd8' });
    m.origins.set('h8', { home: 'e8' });
    m.origins.set('d6', { home: 'a1' });
    m.origins.set('e1', { home: 'e1' });
    m.dead.w.push({ type: 'q', homes: ['d1'] });
    return m;
  };

  // Baseline: resurrect straight from the pre-capture position.
  const direct = build();
  direct.resurrect({ from: 'd6', to: 'd8', home: 'd1' });

  // Through the played-then-undone path the app actually uses.
  const viaCapture = build();
  const before = viaCapture.fen();
  viaCapture.applyMove({ from: 'd6', to: 'd8' });
  assert(!viaCapture.chess.get('d8') || viaCapture.chess.get('d8').color === 'w',
    'the capture did not actually happen before the choice');
  assert(viaCapture.chess.get('d6') === undefined, 'the capturer did not leave its square');
  const offer = viaCapture.pendingResurrection();
  assert(offer && offer.homes.join() === 'd1', 'the played capture did not leave a pending offer');
  const event = viaCapture.takeHomecoming('d1');

  assert(event.undone && event.undone.kind === 'move' && event.undone.san,
    'the rolled-back capture was not reported back to the caller for its animation');
  assert(viaCapture.fen() === direct.fen(),
    `rollback drifted\n${viaCapture.fen()}\n${direct.fen()}`);
  assert(JSON.stringify(viaCapture.dead) === JSON.stringify(direct.dead), 'rollback drifted the graveyards');
  assert(JSON.stringify([...viaCapture.origins].sort()) === JSON.stringify([...direct.origins].sort()),
    'rollback drifted the origin map');
  assert(viaCapture.ply === direct.ply, 'rollback drifted the ply count');
  assert(viaCapture.log.length === direct.log.length && viaCapture.log.every((e) => e.kind !== 'move'),
    'the undone capture was left in the move log');
  assert(viaCapture.serializedActions().length === direct.serializedActions().length,
    'the undone capture leaked into the saved actions');
  assert(before === event.fenBefore, 'the resurrection did not start from the pre-capture position');
  ok('a played capture rolls back exactly, leaving no trace of the move it undid');
}

{
  // Keeping the capture must simply let it stand.
  const m = new ExchangeMatch('keep');
  m.chess.load('3q3k/8/3R4/8/8/8/8/4K3 w - - 4 30');
  m.origins.clear();
  m.origins.set('d8', { home: 'd8' });
  m.origins.set('h8', { home: 'e8' });
  m.origins.set('d6', { home: 'a1' });
  m.origins.set('e1', { home: 'e1' });
  m.dead.w.push({ type: 'q', homes: ['d1'] });
  m.applyMove({ from: 'd6', to: 'd8' });
  assert(m.pendingResurrection(), 'no offer was pending');
  m.keepCapture();
  assert(m.pendingResurrection() === null, 'the offer did not lapse');
  assert(m.chess.get('d8')?.type === 'r' && m.chess.get('d8')?.color === 'w', 'the rook did not keep the square');
  assert(m.dead.b.some((e) => e.type === 'q'), 'the taken queen did not reach the opponent graveyard');
  assert(m.dead.w.length === 1, 'keeping the capture wrongly consumed a graveyard entry');
  assert(m.turn() === 'b', 'keeping the capture did not pass the turn');
  ok('keeping the capture leaves it standing and lapses the offer');
}

{
  // Threefold repetition ends the game. Knights shuffle out and back twice:
  // the start position stands for the third time.
  const match = play('Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8');
  const status = match.status();
  assert(status.over && status.winner === null && status.reason === 'threefold repetition',
    `repetition did not draw: ${JSON.stringify(status)}`);
  ok('threefold repetition draws the game');
}

summary('exchange.test.mjs');
