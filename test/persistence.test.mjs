import { loadActive, saveActive, clearActive } from '../js/core/persistence.js';
import { assert, ok, summary } from './helpers.mjs';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};

const legacy = {
  version: 6,
  seed: 'legacy-seed',
  actions: [{ kind: 'place', color: 'w', square: 'd4' }],
  myColor: 'w',
  level: 'medium',
};

values.set('mv-active-v6', JSON.stringify(legacy));
values.set('mv-active-v7', JSON.stringify({ version: 7, seed: 42 }));
assert(loadActive()?.seed === legacy.seed, 'a malformed v7 save masked a valid v6 game');
ok('a valid legacy game survives a malformed current save');

saveActive({ seed: 'current-seed', actions: [], myColor: 'b', level: 'hard', startedAt: 123 });
const current = JSON.parse(values.get('mv-active-v7'));
assert(current.version === 7 && current.seed === 'current-seed' && current.startedAt === 123,
  'saving did not write the complete v7 record');
assert(!values.has('mv-active-v6'), 'saving v7 did not remove the migrated v6 record');
assert(loadActive()?.seed === 'current-seed', 'the current save was not loaded');
ok('saving upgrades legacy storage to v7');

clearActive();
assert(!values.has('mv-active-v7') && !values.has('mv-active-v6'), 'clearing left an active-game record behind');
ok('clearing removes current and legacy games');

summary('persistence.test.mjs');
