import { loadActive, saveActive, clearActive } from '../js/core/persistence.js';
import { assert, ok, summary } from './helpers.mjs';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};

// Black-hole-era saves (v6-v8) cannot replay under Prisoner Exchange rules;
// they must be ignored, never surfaced as resumable.
values.set('mv-active-v8', JSON.stringify({
  version: 8,
  seed: 'old-black-hole-game',
  actions: [{ kind: 'place', color: 'w', square: 'd4' }],
  myColor: 'w',
  level: 'medium',
}));
assert(loadActive() === null, 'a black-hole-era save was surfaced as resumable');
ok('obsolete black-hole saves are never offered for resume');

saveActive({ seed: 'current-seed', actions: [{ kind: 'move', uci: 'e2e4' }], myColor: 'b', level: 'hard', startedAt: 123 });
const current = JSON.parse(values.get('mv-active-v9'));
assert(current.version === 9 && current.seed === 'current-seed' && current.startedAt === 123,
  'saving did not write the complete v9 record');
assert(!values.has('mv-active-v8'), 'saving v9 did not remove the obsolete v8 record');
assert(loadActive()?.seed === 'current-seed', 'the current save was not loaded');
ok('saving writes v9 and clears obsolete formats');

values.set('mv-active-v9', JSON.stringify({ version: 9, seed: 42 }));
assert(loadActive() === null, 'a malformed v9 save was surfaced as resumable');
ok('a malformed v9 save is ignored');

saveActive({ seed: 's', actions: [], myColor: 'w', level: 'easy' });
clearActive();
assert(!values.has('mv-active-v9') && !values.has('mv-active-v8'),
  'clearing left an active-game record behind');
ok('clearing removes current and obsolete games');

summary('persistence.test.mjs');
