// Regression tests for the review fleet's confirmed findings: the dodge
// protocol only honors LEGAL king-capture attempts, and a dodged pawn
// still gets its promotion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MottyGame } from '../js/engine/game.js';
import { legalMoves, inCheck } from '../js/engine/movegen.js';
import { WHITE, BLACK, P, Q, parseSquare } from '../js/engine/constants.js';
import { FAST_BUDGETS } from './sim.js';

test('illegal king grabs are rejected, not rewarded with a teleport', () => {
  // move 1: queen d1 "captures" king e8 across a wall of pawns
  for (let seed = 1; seed <= 20; seed++) {
    const game = new MottyGame({ seed, budgets: FAST_BUDGETS });
    const r = game.playerMove({ from: 'd1', to: 'e8' });
    assert.equal(r.legal, false, `seed ${seed}: must be illegal`);
    assert.equal(r.reason, 'illegal-target');
    assert.equal(game.board.squares[parseSquare('d1')], Q, 'queen stays home');
    assert.equal(game.board.turn, WHITE, 'no turn consumed');
  }
});

test('a LEGAL king capture still triggers the dodge protocol', () => {
  // black king en prise next to a white rook (ignored-check state)
  let sawDodge = false;
  let sawBounce = false;
  for (let seed = 1; seed <= 30; seed++) {
    const game = new MottyGame({
      seed,
      fen: '4k3/4R3/8/8/8/8/8/4K3 w - - 0 1',
      budgets: FAST_BUDGETS,
    });
    const r = game.playerMove({ from: 'e7', to: 'e8' });
    if (r.legal) {
      sawDodge = true;
      assert.ok(r.events.some((e) => e.type === 'king-dodge'), 'dodge event present');
      assert.ok(game.board.kingB >= 0, 'black king survived');
      assert.notEqual(game.board.kingB, parseSquare('e8'), 'king moved away');
    } else {
      sawBounce = true;
      assert.equal(r.reason, 'king-bounce');
    }
  }
  assert.ok(sawDodge, 'dodge fires most of the time');
  assert.ok(sawBounce, 'bounce fires sometimes');
});

test('a dodged pawn on the 8th rank promotes to the chosen piece', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const game = new MottyGame({
      seed,
      fen: '5k2/4P3/8/8/8/8/3r4/4K3 w - - 0 1',
      budgets: FAST_BUDGETS,
    });
    const r = game.playerMove({ from: 'e7', to: 'f8', promo: 'q' });
    if (!r.legal) continue; // bounce roll; try another seed
    const f8 = game.board.squares[parseSquare('f8')];
    assert.equal(f8, Q, `seed ${seed}: pawn promoted on arrival, no frozen pawn`);
    assert.ok(r.events.some((e) => e.type === 'promotion'), 'promotion event emitted');
    return;
  }
  assert.fail('dodge never fired across 40 seeds');
});

test('PHANTOM_PIN: legal queen captures get gaslit, alternatives still work', () => {
  // white rook a1 can legally take the black queen a8; plenty of alternatives
  let sawPin = false;
  for (let seed = 1; seed <= 40 && !sawPin; seed++) {
    const game = new MottyGame({
      seed,
      fen: 'q3k3/8/8/8/8/8/4PPPP/R3K3 w - - 0 1',
      budgets: FAST_BUDGETS,
    });
    const r = game.playerMove({ from: 'a1', to: 'a8' });
    if (r.legal) continue; // the 40% honest roll; try another seed
    sawPin = true;
    assert.equal(r.reason, 'phantom-pin');
    // retrying the same capture stays rejected, consistently
    const again = game.playerMove({ from: 'a1', to: 'a8' });
    assert.equal(again.legal, false);
    assert.equal(again.reason, 'phantom-pin-repeat');
    // any other move is graciously permitted
    const other = game.playerMove({ from: 'e2', to: 'e4' });
    assert.equal(other.legal, true, 'the player always has a way forward');
    assert.ok(game.cheatsFired.some((c) => c.id === 'PHANTOM_PIN'));
  }
  assert.ok(sawPin, 'the pin fires within 40 seeds');
});

test('PHANTOM_PIN never fires on a forced capture (check evasion)', () => {
  // white Kh1 in contact check from Qg1 (guarded by Rg8): the ONLY legal
  // move is Raxg1, a queen capture. It must never be gaslit.
  for (let seed = 1; seed <= 10; seed++) {
    const game = new MottyGame({
      seed,
      fen: '4k1r1/8/8/8/8/8/7P/R5qK w - - 0 1',
      budgets: FAST_BUDGETS,
    });
    const moves = game.allLegalTargets();
    assert.equal(moves.length, 1, 'fixture is genuinely forced');
    assert.equal(moves[0].to, 'g1');
    const r = game.playerMove({ from: 'a1', to: 'g1' });
    assert.equal(r.legal, true, `seed ${seed}: forced capture must be allowed`);
  }
});

test('resign is idempotent at the engine level', () => {
  const game = new MottyGame({ seed: 5, budgets: FAST_BUDGETS });
  assert.equal(game.resign(), 'white-mated');
  assert.equal(game.resign(), 'white-mated');
});
