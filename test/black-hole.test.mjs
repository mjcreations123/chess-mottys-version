import { BlackHoleMatch, replayMatch } from '../js/core/black-hole.js';
import { assert, ok, summary } from './helpers.mjs';

function at(fen, whiteHole, blackHole, seed = 'rule-test') {
  const match = new BlackHoleMatch(seed);
  match.chess.load(fen);
  match.chess.setHoles([]);
  match.selectBlackHole('w', whiteHole);
  match.selectBlackHole('b', blackHole);
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
  match.selectBlackHole('b', 'd4');
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
  const match = at(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'd4', 'e4', 'trigger',
  );
  match.applyMove({ from: 'e2', to: 'e4' });
  const [event] = match.resolveBlackHoleIfDue();
  assert(event.owner === 'b' && event.square === 'e4', 'wrong black hole triggered');
  assert(!match.chess.get('e4'), 'landing piece survived the black hole');
  assert(match.collapsed.has('e4'), 'triggered square did not collapse');
  assert(match.activeBlackHole('b') === null && match.selectionRequired('b'), 'spent black hole was not retired');
  assert(match.legalMoves().length === 0, 'play continued before the replacement was selected');
  match.selectBlackHole('b', 'e5');
  assert(match.readyToPlay(), 'replacement did not resume play');
  ok('an opponent landing consumes the piece, square and one-use trap');
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
  assert(match.chess.get('g1')?.type === 'k' && !match.chess.get('f1'), 'castling collapse removed the wrong piece');
  ok('a castling rook can fall into a black hole');
}

{
  const match = new BlackHoleMatch('collision');
  match.selectBlackHole('b', 'd4');
  const placement = match.selectBlackHole('w', 'd4');
  assert(placement.displaced === 'b', 'secret-square collision was not reconciled');
  assert(match.activeBlackHole('w') === 'd4' && match.selectionRequired('b'), 'latest secret did not keep the colliding square');
  const replacement = match.selectRandomBlackHole('b');
  assert(replacement.square !== 'd4', 'displaced bot selected the player\'s active square again');
  ok('colliding secret choices stay hidden and preserve one active trap each');
}

{
  const a = new BlackHoleMatch('same-seed');
  const b = new BlackHoleMatch('same-seed');
  a.selectBlackHole('w', 'd4');
  b.selectBlackHole('w', 'd4');
  const ah = a.selectRandomBlackHole('b');
  const bh = b.selectRandomBlackHole('b');
  assert(ah.square === bh.square, 'same seed produced different MottyBot holes');
  ok('MottyBot black-hole selection is deterministic per seed and sequence');
}

{
  const original = at(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'd4', 'e4', 'replay',
  );
  original.applyMove({ from: 'e2', to: 'e4' });
  original.resolveBlackHoleIfDue();
  original.selectBlackHole('b', 'e5');
  const restored = replayMatch(original.seed, original.serializedActions());
  assert(restored.fen() === original.fen(), `replay FEN drifted\n${restored.fen()}\n${original.fen()}`);
  assert(JSON.stringify(restored.collapsedSquares()) === JSON.stringify(original.collapsedSquares()), 'replay lost collapsed squares');
  assert(restored.activeBlackHole('w') === original.activeBlackHole('w')
    && restored.activeBlackHole('b') === original.activeBlackHole('b'), 'replay lost active black holes');
  ok('saved actions reproduce pieces, active traps and collapsed terrain');
}

summary('black-hole.test.mjs');
