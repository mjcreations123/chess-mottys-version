// v7 adds turn-forfeiting black-hole relocations. Existing v6 games remain
// compatible and are upgraded the next time they are saved.
const ACTIVE_KEY = 'mv-active-v7';
const LEGACY_ACTIVE_KEY = 'mv-active-v6';
const STATS_KEY = 'mv-stats-v3';
const RULES_KEY = 'mv-rules-seen-v6';

const read = (key, fallback) => {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
};

export function loadActive() {
  const valid = (data) => data
    && [6, 7].includes(data.version)
    && typeof data.seed === 'string'
    && Array.isArray(data.actions)
    && ['w', 'b'].includes(data.myColor)
    && ['easy', 'medium', 'hard'].includes(data.level);
  const current = read(ACTIVE_KEY, null);
  if (valid(current)) return current;
  const legacy = read(LEGACY_ACTIVE_KEY, null);
  return valid(legacy) ? legacy : null;
}

export function saveActive({ seed, actions, myColor, level, startedAt = Date.now() }) {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({
      version: 7,
      seed,
      actions,
      myColor,
      level,
      startedAt,
      savedAt: Date.now(),
    }));
    localStorage.removeItem(LEGACY_ACTIVE_KEY);
  } catch { /* storage failure must never interrupt a game */ }
}

export function clearActive() {
  try {
    localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem(LEGACY_ACTIVE_KEY);
  } catch {}
}

export function loadStats() {
  const s = read(STATS_KEY, null);
  return {
    played: Number(s?.played) || 0,
    wins: Number(s?.wins) || 0,
    losses: Number(s?.losses) || 0,
    draws: Number(s?.draws) || 0,
    streak: Number(s?.streak) || 0,
    bestStreak: Number(s?.bestStreak) || 0,
  };
}

export function recordResult(outcome) {
  const s = loadStats();
  s.played++;
  if (outcome === 'win') {
    s.wins++;
    s.streak++;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
  } else if (outcome === 'loss') {
    s.losses++;
    s.streak = 0;
  } else {
    s.draws++;
    s.streak = 0;
  }
  try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch {}
  return s;
}

export function rulesSeen() { return localStorage.getItem(RULES_KEY) === '1'; }
export function markRulesSeen() { try { localStorage.setItem(RULES_KEY, '1'); } catch {} }
