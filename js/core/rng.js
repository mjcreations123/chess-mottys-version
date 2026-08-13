// Deterministic seeded RNG. Multiplayer clients must derive identical
// teleport sequences from the shared game seed, so every random draw in the
// rules engine goes through this and nothing else. Never Math.random() here.

// xmur3 string hash -> u32 seed
export function seedFromString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

// mulberry32
export function makeRng(seedU32) {
  let a = seedU32 >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(n) { return Math.floor(next() * n); },
    pick(arr) { return arr[this.int(arr.length)]; },
    // Fisher-Yates on a copy; consumes exactly arr.length - 1 draws
    shuffle(arr) {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) {
        const j = this.int(i + 1);
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
  };
}

// One rng per teleport phase: seed#ply
export function phaseRng(gameSeed, ply) {
  return makeRng(seedFromString(`${gameSeed}#${ply}`));
}

// Non-deterministic seed for new games (uses crypto when available)
export function randomSeed() {
  if (globalThis.crypto?.getRandomValues) {
    const buf = new Uint32Array(2);
    globalThis.crypto.getRandomValues(buf);
    return buf[0].toString(36) + buf[1].toString(36);
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
