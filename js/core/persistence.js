// v4: the teleport schedule changed (Fate eases off in the endgame), so a v3
// save would replay into a different position than the one it was saved from.
const ACTIVE_KEY = 'mv-active-v4';
const STATS_KEY = 'mv-stats-v3';
const RULES_KEY = 'mv-rules-seen-v3';

const read = (key, fallback) => {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
};

export function loadActive() {
  const data = read(ACTIVE_KEY, null);
  if (!data || data.version !== 4 || typeof data.seed !== 'string' || !Array.isArray(data.ucis)) return null;
  if (!['w', 'b'].includes(data.myColor)) return null;
  if (!['easy', 'medium', 'hard'].includes(data.level)) return null;
  return data;
}

export function saveActive({ seed, ucis, myColor, level, startedAt = Date.now() }) {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({
      version: 4,
      seed,
      ucis,
      myColor,
      level,
      startedAt,
      savedAt: Date.now(),
    }));
  } catch { /* storage failure must never interrupt a game */ }
}

export function clearActive() {
  try { localStorage.removeItem(ACTIVE_KEY); } catch {}
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
