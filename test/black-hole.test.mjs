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
    'e4', 'd4', 'own-safe',
  );
  match.applyMove({ from: 'e2', to: 'e4' });
  const events = match.resolveBlackHoleIfDue();
  assert(events.length === 0, 'a player triggered their own black hole');
  assert(match.chess.get('e4')?.type === 'p', 'piece did not survive on its owner\'s black hole');
  assert(match.activeBlackHole('w') === 'e4', 'own black hole was consumed');
  ok('a black hole affects only the opponent');
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
  match.selectBlackHole('b', 'e5', { automatic: true });
  assert(match.activeBlackHole('b') === 'e5', 'the same square could not be armed again');
  const rookRoute = match.legalMoves('e8').find((move) => move.to === 'e5');
  assert(rookRoute, 'an owner piece could not use the reopened square normally');
  match.applyMove({ from: 'e8', to: 'e5' });
  assert(match.resolveBlackHoleIfDue().length === 0, 'an owner piece triggered its rearmed black hole');
  assert(match.chess.get('e5')?.type === 'r', 'the reopened square did not behave like an ordinary square');
  ok('a spent square reopens immediately and may be armed again');
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
  const match = at('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'a4', 'e2', 'king-fall');
  match.applyMove({ from: 'e1', to: 'e2' });
  const [event] = match.resolveBlackHoleIfDue();
  const status = match.status();
  assert(event.kingLost, 'king fall was not identified');
  assert(status.over && status.winner === 'b' && status.blackHole.cause === 'king-fell', 'king fall did not end the game for the trap owner');
  ok('a king that lands on a black hole loses immediately');
}

{
  const match = at('4k3/8/8/8/8/8/8/4K2R w K - 0 1', 'a4', 'f1', 'castle');
  match.applyMove({ from: 'e1', to: 'g1' });
  const [event] = match.resolveBlackHoleIfDue();
  assert(event.role === 'castling rook' && event.piece.type === 'r', 'castling rook did not trigger its landing square');
  assert(match.chess.get('g1')?.type === 'k' && !match.chess.get('f1'), 'the trap removed the wrong castling piece');
  ok('a castling rook can fall into a black hole');
}

{
  const match = new BlackHoleMatch('collision');
  match.selectBlackHole('b', 'd4', { automatic: true });
  const placement = match.selectBlackHole('w', 'd4');
  assert(placement.displaced === 'b', 'secret-square collision was not reconciled');
  assert(match.activeBlackHole('w') === 'd4' && match.selectionRequired('b'), 'latest secret did not keep the colliding square');
  const replacement = match.selectFallbackBlackHole('b', ['d4']);
  assert(replacement.square !== 'd4', 'displaced bot selected the player\'s active square again');
  ok('colliding secret choices stay hidden and preserve one active trap each');
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
  const restored = replayMatch(original.seed, original.serializedActions());
  assert(restored.fen() === original.fen(), `replay FEN drifted\n${restored.fen()}\n${original.fen()}`);
  assert(restored.blackHolesTriggered() === 1 && restored.lastTriggeredSquare('b') === 'e4', 'replay lost trigger history');
  assert(restored.activeBlackHole('w') === original.activeBlackHole('w')
    && restored.activeBlackHole('b') === original.activeBlackHole('b'), 'replay lost active black holes');
  assert(restored.log.findLast((event) => event.kind === 'placement')?.automatic, 'replay lost automatic placement ownership');
  ok('saved actions reproduce pieces, active traps and a same-square rearm');
}

summary('black-hole.test.mjs');
