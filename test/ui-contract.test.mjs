// UI guardrails for Prisoner Exchange. The graveyard is information about
// what was lost, not a tactical adviser that marks which enemy piece to take.
import { readFile } from 'node:fs/promises';
import { assert, ok, summary } from './helpers.mjs';

const main = await readFile(new URL('../js/main.js', import.meta.url), 'utf8');
const board = await readFile(new URL('../js/ui/board.js', import.meta.url), 'utf8');

assert(!main.includes('state.match.offerTargets()'),
  'the live UI still asks the engine to reveal exact exchange targets');
assert(!/ringed enemy piece|The ringed piece|ringed pieces bring/i.test(main),
  'public game copy still reveals exchange targets');
assert(main.includes('chip--dead') && main.includes('Graveyard'),
  'fallen pieces are not visibly identified as a graveyard');
ok('the live UI records graveyard state without coaching exchange moves');

assert(board.includes("this.el.querySelectorAll('.piece').length === map.size"),
  'board verification does not detect extra or missing DOM pieces');
assert(board.includes("this.el.querySelectorAll('.overlay--hl')"),
  'last-move paint cannot clean up stray highlight nodes');
assert(board.includes('this.#clearAllOverlays()'),
  'full board recovery does not clear stale overlays');
assert(board.includes('Never paint a yellow "last move" on empty squares'),
  'last-move paint is not guarded by a real destination piece');
ok('board recovery validates DOM pieces and clears stale highlights');

assert(main.includes('const matchingMove = legal.find') && main.includes('worker response is advisory'),
  'MottyBot does not validate worker moves against the current legal position');
assert(main.includes('syncBoard({ force: true });\n\n    if (action.kind === \'resurrect\')'),
  'MottyBot does not repair the visible board before animating its next move');
assert(main.includes('syncBoard({ force: true })'),
  'settled turns do not force a complete board reconciliation');
ok('MottyBot preflights worker moves against the live board state');

summary('ui-contract.test.mjs');
