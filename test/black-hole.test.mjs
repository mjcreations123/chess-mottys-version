import { BlackHoleMatch, replayMatch } from '../js/core/black-hole.js';
import { assert, ok, summary } from './helpers.mjs';

function at(fen, whiteHole, blackHole, seed = 'rule-test') {
  const match = new BlackHoleMatch(seed);
  match.chess.load(fen);
  match.selectBlackHole('w', whiteHole);
  match.selectBlackHole('b', blackHole, { automatic: true });
  return match;
}

{
  const match = new BlackHoleMatch('setup');
  assert(match.selectionRequired('w') && match.selectionRequired('b'), 'both players must choose before move one');
  assert(match.legalMoves().length === 0, 'moves must wait for both secret choices');
  let rejected = false;
  try { match.selectBlackHole('w', 'e2'); } catch { rejected = true; }
  assert(rejected, 'an occupied square was accepted as a black hole');
  match.selectBlackHole('w', 'e4');
  match.selectBlackHole('b', 'd4', { automatic: true });
  assert(match.readyToPlay(), 'match did not become ready after both choices');
  ok('setup requires one empty secret square per player');
}

{
  const match = at(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'e4', 'd4', 'self-catch',
  );
  match.applyMove({ from: 'e2', to: 'e4' });
  const [event] = match.resolveBlackHoleIfDue();
  assert(event.owner === 'w' && event.victimColor === 'w', 'a piece landing on its own owner\'s trap was not caught');
  assert(!match.chess.get('e4'), 'a piece survived landing on its own owner\'s black hole');
  assert(match.activeBlackHole('w') === null && match.selectionRequired('w'),
    'the owner\'s spent trap did not require a re-arm');
  ok('a black hole catches its own owner\'s pieces too, not just the opponent\'s');
}

{
  const match = at(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'e4', 'e4', 'shared-self-catch',
  );
  match.applyMove({ from: 'e2', to: 'e4' });
  const events = match.resolveBlackHoleIfDue();
  assert(events.length === 2, 'a square shared by both secret traps did not fire for both owners');
  assert(!match.chess.get('e4'), 'the piece survived a doubly-trapped square');
  assert(match.selectionRequired('w') && match.selectionRequired('b'),
    'a shared trigger did not require both owners to re-arm');
  ok('a square shared by both secret traps consumes both when anything lands there');
}

{
  const match = at('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'e4', 'a4', 'self-king-fall');
  match.applyMove({ from: 'e1', to: 'e2' });
  assert(match.resolveBlackHoleIfDue().length === 0, 'an empty step triggered a black hole');
  match.applyMove({ from: 'e8', to: 'd8' });
  match.resolveBlackHoleIfDue();
  match.applyMove({ from: 'e2', to: 'e3' });
  assert(match.resolveBlackHoleIfDue().length === 0, 'an empty step triggered a black hole');
  match.applyMove({ from: 'd8', to: 'c8' });
  match.resolveBlackHoleIfDue();
  match.applyMove({ from: 'e3', to: 'e4' });
  const [event] = match.resolveBlackHoleIfDue();
  const status = match.status();
  assert(event.kingLost && event.owner === 'w' && event.victimColor === 'w',
    'a king landing on its own owner\'s trap was not recognised');
  assert(status.over && status.winner === 'b',
    'a king that falls into its own trap should hand the win to the other side, not its own');
  ok('a king that blunders into its own black hole loses for its own side');
}

{
  const match = at('k3r3/8/8/8/4P3/8/8/4K3 w - - 37 1', 'a4', 'e5', 'reopen');
  match.applyMove({ from: 'e4', to: 'e5' });
  const [event] = match.resolveBlackHoleIfDue();
  assert(event.owner === 'b' && event.square === 'e5' && event.reopened, 'wrong black hole triggered');
  assert(!match.chess.get('e5'), 'landing piece survived the black hole');
  assert(match.fen().split(' ')[4] === '0', 'a black-hole loss did not reset the fifty-move clock');
  assert(match.activeBlackHole('b') === null && match.selectionRequired('b'), 'spent black hole was not retired');
  assert(match.eligibleBlackHoles('b').includes('e5'), 'the spent square was not immediately eligible again');
  assert(match.legalMoves().length === 0, 'play continued before the replacement was selected');
  // Re-arm somewhere else so the rook's move below lands on ordinary ground
  // rather than walking straight back into a live trap of its own.
  match.selectBlackHole('b', 'a5', { automatic: true });
  assert(match.relocationsRemaining('b') === 3, 'mandatory re-arming consumed a voluntary relocation');
  const rookRoute = match.legalMoves('e8').find((move) => move.to === 'e5');
  assert(rookRoute, 'a piece could not use the reopened square normally');
  match.applyMove({ from: 'e8', to: 'e5' });
  assert(match.resolveBlackHoleIfDue().length === 0, 'the reopened square still behaved like a live trap');
  assert(match.chess.get('e5')?.type === 'r', 'the reopened square did not behave like an ordinary square');
  ok('a spent square reopens immediately and may be armed again, this time elsewhere');
}

{
  const match = at(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'd4', 'e4', 'relocate-turn',
  );
  let rejectedSame = false;
  try { match.relocateBlackHole('w', 'd4'); } catch { rejectedSame = true; }
  assert(rejectedSame && match.relocationsUsed('w') === 0 && match.turn() === 'w', 'same-square relocation consumed a turn or use');

  const pieceField = match.fen().split(' ')[0];
  const event = match.relocateBlackHole('w', 'c4');
  assert(event.from === 'd4' && event.to === 'c4' && event.remaining === 2, 'relocation event was incorrect');
  assert(match.activeBlackHole('w') === 'c4', 'active black hole did not move');
  assert(match.turn() === 'b' && match.ply === 1, 'relocation did not consume White\'s turn');
  assert(match.fen().split(' ')[0] === pieceField, 'relocation changed a chess piece square');
  assert(match.fen().split(' ')[4] === '1', 'relocation did not advance the fifty-move clock');
  assert(match.eligibleRelocationSquares('w').includes('d4'), 'old black-hole square did not become an ordinary relocation choice');
  ok('a voluntary relocation moves only the trap and consumes the chess turn');
}

{
  const match = at(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'd4', 'e4', 'relocate-limit',
  );
  const blackMoves = [
    { from: 'e7', to: 'e5' },
    { from: 'g8', to: 'f6' },
    { from: 'b8', to: 'c6' },
  ];
  for (let index = 0; index < 3; index++) {
    match.relocateBlackHole('w', index % 2 === 0 ? 'c4' : 'd4');
    match.applyMove(blackMoves[index]);
    match.resolveBlackHoleIfDue();
  }
  assert(match.relocationsRemaining('w') === 0 && match.turn() === 'w', 'three relocations did not exhaust the allowance');
  let rejectedFourth = false;
  try { match.relocateBlackHole('w', 'd4'); } catch { rejectedFourth = true; }
  assert(rejectedFourth && match.relocationsUsed('w') === 3 && match.turn() === 'w', 'a fourth relocation was allowed or consumed state');
  ok('each side is limited to three voluntary relocations');
}

{
  const match = at('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1', 'a4', 'b4', 'relocate-check');
  assert(match.status().check, 'check fixture did not put White in check');
  assert(!match.canRelocateBlackHole('w'), 'relocation was offered while the king was in check');
  let rejected = false;
  try { match.relocateBlackHole('w', 'c4'); } catch { rejected = true; }
  assert(rejected && match.turn() === 'w' && match.relocationsUsed('w') === 0, 'illegal in-check relocation changed the game');
  ok('relocation cannot replace the required answer to check');
}

{
  const match = at(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'd4', 'c4', 'relocate-collision',
  );
  match.relocateBlackHole('w', 'c4');
  assert(match.activeBlackHole('w') === 'c4' && match.activeBlackHole('b') === 'c4',
    'relocation did not preserve both hidden traps on the shared square');
  assert(match.readyToPlay() && !match.selectionRequired('w') && !match.selectionRequired('b'),
    'sharing a square forced an unrelated replacement');
  ok('relocating onto the opponent\'s hidden square does not force a second selection');
}

{
  const match = at('4k3/8/8/8/4P3/8/8/4K3 w - - 0 1', 'a4', 'd5', 'double-loss');
  match.chess.put({ type: 'p', color: 'b' }, 'd5');
  match.applyMove({ from: 'e4', to: 'd5' });
  match.resolveBlackHoleIfDue();
  assert(!match.chess.get('d5'), 'capture destination was not emptied by the black hole');
  const captured = match.captured();
  assert(captured.byWhite.includes('p') && captured.byBlack.includes('p'), 'capture plus black-hole loss was not credited to both sides');
  ok('a capture can remove both the captured and arriving pieces');
}

{
  // e2 sits beside White's own king (e1) and could never be a legal first
  // pick any more; the king still has to be able to walk into a trap set
  // several squares away, which is what actually matters here.
  const match = at('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'a4', 'e4', 'king-fall');
  match.applyMove({ from: 'e1', to: 'e2' });
  assert(match.resolveBlackHoleIfDue().length === 0, 'an empty step triggered a black hole');
  match.applyMove({ from: 'e8', to: 'd8' });
  match.resolveBlackHoleIfDue();
  match.applyMove({ from: 'e2', to: 'e3' });
  assert(match.resolveBlackHoleIfDue().length === 0, 'an empty step triggered a black hole');
  match.applyMove({ from: 'd8', to: 'c8' });
  match.resolveBlackHoleIfDue();
  match.applyMove({ from: 'e3', to: 'e4' });
  const [event] = match.resolveBlackHoleIfDue();
  const status = match.status();
  assert(event.kingLost, 'king fall was not identified');
  assert(status.over && status.winner === 'b' && status.blackHole.cause === 'king-fell', 'king fall did not end the game for the trap owner');
  ok('a king that lands on a black hole loses immediately, even several squares from where the trap was set');
}

{
  // f1 sits beside White's uncastled king (e1), so Black's very first pick
  // could never land there. Relocating once the position has moved on is
  // how the castling-rook mechanic is meant to be reached now.
  const match = at('4k3/8/8/8/8/8/4P3/4K2R w K - 0 1', 'a4', 'h4', 'castle');
  assert(match.eligibleRelocationSquares('b').includes('f1'),
    'relocation should be able to reach a square beside a king even though a first pick cannot');
  match.applyMove({ from: 'e2', to: 'e3' });
  assert(match.resolveBlackHoleIfDue().length === 0, 'a quiet pawn move triggered a black hole');
  const relocation = match.relocateBlackHole('b', 'f1');
  assert(relocation.to === 'f1', 'relocation onto the castling square failed');
  match.applyMove({ from: 'e1', to: 'g1' });
  const [event] = match.resolveBlackHoleIfDue();
  assert(event.role === 'castling rook' && event.piece.type === 'r', 'castling rook did not trigger its landing square');
  assert(match.chess.get('g1')?.type === 'k' && !match.chess.get('f1'), 'the trap removed the wrong castling piece');
  ok('a castling rook can fall into a black hole placed there after the opening');
}

{
  const match = new BlackHoleMatch('collision');
  match.selectBlackHole('b', 'd4', { automatic: true });
  match.selectBlackHole('w', 'd4');
  assert(match.activeBlackHole('w') === 'd4' && match.activeBlackHole('b') === 'd4',
    'same-square secrets did not remain active together');
  assert(match.readyToPlay() && !match.selectionRequired('w') && !match.selectionRequired('b'),
    'same-square secrets forced an extra selection');
  ok('colliding secret choices remain active without revealing or replacing either trap');
}

{
  const match = at('4k3/8/8/8/4P3/8/8/4K3 w - - 0 1', 'a4', 'd5', 'single-rearm');
  match.chess.put({ type: 'p', color: 'b' }, 'd5');
  match.applyMove({ from: 'e4', to: 'd5' });
  const [event] = match.resolveBlackHoleIfDue();
  assert(event.owner === 'b' && event.victimColor === 'w', 'the opponent-owned trap did not catch the moving piece');
  assert(match.activeBlackHole('w') === 'a4' && match.activeBlackHole('b') === null,
    'an unrelated owner trap was disturbed by a capture on a different square');
  assert(!match.selectionRequired('w') && match.selectionRequired('b'),
    'both players were asked to re-arm after one piece fell');
  match.selectBlackHole('b', 'd5', { automatic: true });
  assert(match.readyToPlay() && match.activeBlackHole('w') === 'a4' && match.activeBlackHole('b') === 'd5',
    'the single required re-arm did not restore play');
  ok('one fall consumes one trap and requires exactly one owner to re-arm when the traps do not coincide');
}

{
  // e3 is White's own third rank, off limits for a first pick; relocating
  // there once the position has moved on is how this scenario is reached.
  const match = at('4k3/8/8/8/3p4/8/8/4K3 b - - 0 1', 'a4', 'h5', 'single-rearm-reverse');
  match.applyMove({ from: 'e8', to: 'd8' });
  match.resolveBlackHoleIfDue();
  match.relocateBlackHole('w', 'e3');
  match.chess.put({ type: 'p', color: 'w' }, 'e3');
  match.applyMove({ from: 'd4', to: 'e3' });
  const [event] = match.resolveBlackHoleIfDue();
  assert(event.owner === 'w' && event.victimColor === 'b', 'the player-owned trap did not catch MottyBot');
  assert(match.activeBlackHole('b') === 'h5' && match.activeBlackHole('w') === null,
    'an unrelated owner trap was disturbed by a capture on a different square');
  assert(match.selectionRequired('w') && !match.selectionRequired('b'),
    'MottyBot was asked to re-arm when its own piece fell');
  match.selectBlackHole('w', 'e3');
  assert(match.readyToPlay() && match.activeBlackHole('w') === 'e3' && match.activeBlackHole('b') === 'h5',
    'the player\'s single re-arm did not restore play');
  ok('the one-owner re-arm rule is symmetric when MottyBot falls, when the traps do not coincide');
}

{
  const match = new BlackHoleMatch('king-proximity');
  match.chess.load('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  const eligible = match.eligibleBlackHoles('w');
  for (const near of ['d1', 'd2', 'e2', 'f1', 'f2', 'd8', 'd7', 'e7', 'f8', 'f7']) {
    assert(!eligible.includes(near), `${near} sits beside a king and should not be an eligible first pick`);
  }
  assert(eligible.includes('a4'), 'a square nowhere near either king was wrongly excluded');
  let rejected = false;
  try { match.selectBlackHole('w', 'e2'); } catch { rejected = true; }
  assert(rejected, 'a first pick beside a king was accepted');
  ok('the first black hole cannot be planted beside either king');
}

{
  const match = new BlackHoleMatch('third-rank');
  match.chess.load('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const whiteFirst = match.eligibleBlackHoles('w');
  for (const sq of ['a3', 'b3', 'c3', 'd3', 'e3', 'f3', 'g3', 'h3']) {
    assert(!whiteFirst.includes(sq), `White's own first pick allowed ${sq}, in front of its own pawns`);
  }
  let rejected = false;
  try { match.selectBlackHole('w', 'c3'); } catch { rejected = true; }
  assert(rejected, 'White\'s very first black hole was allowed onto its own third rank');
  match.selectBlackHole('w', 'd4');

  const blackFirst = match.eligibleBlackHoles('b');
  for (const sq of ['a6', 'b6', 'c6', 'd6', 'e6', 'f6', 'g6', 'h6']) {
    assert(!blackFirst.includes(sq), `Black's own first pick allowed ${sq}, in front of its own pawns`);
  }
  assert(blackFirst.includes('d3'), 'the restriction leaked onto a rank nobody asked for');
  ok('the first black hole cannot be planted in front of its own owner\'s pawns');
}

{
  const match = at('k3r3/8/8/8/4P3/8/8/4K3 w - - 37 1', 'a4', 'e5', 'third-rank-rearm');
  match.applyMove({ from: 'e4', to: 'e5' });
  match.resolveBlackHoleIfDue();
  const rearmChoices = match.eligibleBlackHoles('b');
  assert(rearmChoices.includes('e6'), 'the re-arm pick was still blocked from the rank in front of Black\'s own pawns');
  ok('the rank-in-front-of-your-own-pawns limit applies only to the very first black hole');
}

{
  const restored = replayMatch('legacy-collision', [
    { kind: 'place', color: 'b', square: 'd4', automatic: true },
    { kind: 'place', color: 'w', square: 'd4', automatic: false },
    { kind: 'place', color: 'b', square: 'e4', automatic: true },
  ]);
  assert(restored.activeBlackHole('w') === 'd4' && restored.activeBlackHole('b') === 'e4' && restored.readyToPlay(),
    'legacy exclusive-collision actions did not migrate to their final trap positions');
  ok('legacy collision saves replay under the shared-square rule');
}

{
  const a = new BlackHoleMatch('same-seed');
  const b = new BlackHoleMatch('same-seed');
  a.selectBlackHole('w', 'd4');
  b.selectBlackHole('w', 'd4');
  const ah = a.selectFallbackBlackHole('b', ['d4']);
  const bh = b.selectFallbackBlackHole('b', ['d4']);
  assert(ah.square === bh.square, 'same seed produced different fallback holes');
  ok('emergency black-hole placement is deterministic');
}

{
  const original = at(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'd4', 'e4', 'replay',
  );
  original.applyMove({ from: 'e2', to: 'e4' });
  original.resolveBlackHoleIfDue();
  original.selectBlackHole('b', 'e4', { automatic: true });
  original.relocateBlackHole('b', 'd5', { automatic: true });
  const restored = replayMatch(original.seed, original.serializedActions());
  assert(restored.fen() === original.fen(), `replay FEN drifted\n${restored.fen()}\n${original.fen()}`);
  assert(restored.blackHolesTriggered() === 1 && restored.lastTriggeredSquare('b') === 'e4', 'replay lost trigger history');
  assert(restored.activeBlackHole('w') === original.activeBlackHole('w')
    && restored.activeBlackHole('b') === original.activeBlackHole('b'), 'replay lost active black holes');
  assert(restored.relocationsUsed('b') === 1 && restored.relocationsRemaining('b') === 2, 'replay lost relocation allowance');
  assert(restored.log.findLast((event) => event.kind === 'placement')?.automatic, 'replay lost automatic placement ownership');
  assert(restored.log.findLast((event) => event.kind === 'relocation')?.automatic, 'replay lost relocation ownership');
  ok('saved actions reproduce pieces, active traps, a same-square rearm and a relocation');
}

summary('black-hole.test.mjs');
