import { loadActive, saveActive, clearActive } from '../js/core/persistence.js';
import { assert, ok, summary } from './helpers.mjs';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};

// Old save formats, including the pre-render-hardening v9 format, are never
// resumed into the current Prisoner Exchange transaction model.
values.set('mv-active-v8', JSON.stringify({
  version: 8,
  seed: 'old-black-hole-game',
  actions: [{ kind: 'place', color: 'w', square: 'd4' }],
  myColor: 'w',
  level: 'medium',
}));
assert(loadActive() === null, 'a black-hole-era save was surfaced as resumable');
ok('obsolete black-hole saves are never offered for resume');

values.set('mv-active-v9', JSON.stringify({
  version: 9,
  seed: 'pre-render-repair-game',
  actions: [{ kind: 'move', uci: 'e2e4' }],
  myColor: 'w',
  level: 'medium',
}));
assert(loadActive() === null, 'a pre-render-repair save was surfaced as resumable');
ok('pre-render-repair v9 saves start fresh under the hardened build');

saveActive({ seed: 'current-seed', actions: [{ kind: 'move', uci: 'e2e4' }], myColor: 'b', level: 'hard', startedAt: 123 });
const current = JSON.parse(values.get('mv-active-v10'));
assert(current.version === 10 && current.seed === 'current-seed' && current.startedAt === 123,
  'saving did not write the complete v10 record');
assert(!values.has('mv-active-v9') && !values.has('mv-active-v8'),
  'saving v10 did not remove obsolete active-game records');
assert(loadActive()?.seed === 'current-seed', 'the current save was not loaded');
ok('saving writes v10 and clears obsolete formats');

values.set('mv-active-v10', JSON.stringify({ version: 10, seed: 42 }));
assert(loadActive() === null, 'a malformed v10 save was surfaced as resumable');
ok('a malformed v10 save is ignored');

saveActive({ seed: 's', actions: [], myColor: 'w', level: 'easy' });
clearActive();
assert(!values.has('mv-active-v10') && !values.has('mv-active-v9') && !values.has('mv-active-v8'),
  'clearing left an active-game record behind');
ok('clearing removes current and obsolete games');

summary('persistence.test.mjs');
