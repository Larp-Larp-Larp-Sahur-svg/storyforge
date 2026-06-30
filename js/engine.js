// engine.js — StoryForge PURE MATH CORE
// Everything mechanical is deterministic: given the same (seed, choice history),
// the game always produces the same dice, checks, and outcomes. The AI only
// writes prose; the math here decides what actually happens.

// ---- Deterministic hashing + PRNG (no Math.random anywhere) ----
export function hashStr(str) {
  str = String(str);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Mulberry32 — tiny, fast, well-distributed seeded PRNG.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A reproducible RNG keyed to (runSeed, turnIndex, salt) so every turn's rolls
// are independent yet fully replayable.
export function rngFor(seed, turn, salt = 0) {
  const mixed =
    (hashStr(String(seed)) ^
      Math.imul(turn + 1, 2654435761) ^
      Math.imul(salt + 1, 40503)) >>>
    0;
  return mulberry32(mixed);
}

export function rollDie(rng, sides) {
  return 1 + Math.floor(rng() * sides);
}
export function roll(rng, n, sides) {
  let s = 0;
  for (let i = 0; i < n; i++) s += rollDie(rng, sides);
  return s;
}

// D&D-style ability modifier.
export const mod = (score) => Math.floor((score - 10) / 2);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Core skill check: d20 + ability mod + skill bonus vs a difficulty class.
export function check(rng, statScore, skillBonus, difficulty) {
  const d = rollDie(rng, 20);
  const total = d + mod(statScore) + (skillBonus || 0);
  const margin = total - difficulty;
  const success = d === 20 ? true : d === 1 ? false : total >= difficulty;
  let degree;
  if (d === 20) degree = "critical success";
  else if (d === 1) degree = "critical failure";
  else if (success && margin >= 10) degree = "great success";
  else if (success) degree = "success";
  else if (margin <= -10) degree = "disaster";
  else degree = "failure";
  return { d20: d, total, difficulty, margin, crit: d === 20, fumble: d === 1, success, degree };
}

// Pre-roll odds for a check, shown to the player before they choose (pure math, no sim needed).
export function odds(statScore, skillBonus, difficulty) {
  const need = difficulty - mod(statScore) - (skillBonus || 0);
  // d20 success faces: total>=DC OR natural 20; natural 1 always fails.
  let succ = 0;
  for (let face = 1; face <= 20; face++) {
    if (face === 20) succ++;
    else if (face === 1) continue;
    else if (face >= need) succ++;
  }
  return Math.round((succ / 20) * 100);
}

// Leveling math — a clean quadratic XP curve.
export function xpForLevel(level) {
  return Math.round(50 * level * level + 50 * level);
}
export function levelFromXp(xp) {
  let l = 1;
  while (xp >= xpForLevel(l)) l++;
  return l;
}

// Apply a numeric/array state delta from the narrator to the run state, safely.
export function applyDelta(state, delta) {
  if (!delta || typeof delta !== "object") return state;
  if (delta.stats) {
    for (const k of Object.keys(delta.stats)) {
      state.stats[k] = (state.stats[k] || 0) + Number(delta.stats[k] || 0);
    }
  }
  if (delta.hp != null) state.hp = clamp(state.hp + Number(delta.hp), 0, state.hpMax);
  if (delta.hpMax != null) state.hpMax = Math.max(1, state.hpMax + Number(delta.hpMax));
  if (delta.xp != null) {
    const oldLvl = state.level;
    state.xp = Math.max(0, state.xp + Number(delta.xp));
    state.level = levelFromXp(state.xp);
    if (state.level > oldLvl) state.statPoints = (state.statPoints || 0) + 2 * (state.level - oldLvl);
  }
  if (delta.gold != null) state.gold = Math.max(0, (state.gold || 0) + Number(delta.gold));
  if (Array.isArray(delta.addItems)) for (const it of delta.addItems) if (!state.inventory.includes(it)) state.inventory.push(it);
  if (Array.isArray(delta.removeItems)) state.inventory = state.inventory.filter((i) => !delta.removeItems.includes(i));
  if (Array.isArray(delta.addFlags)) for (const f of delta.addFlags) if (!state.flags.includes(f)) state.flags.push(f);
  if (delta.location) { state.location = String(delta.location); if (!Array.isArray(state.visited)) state.visited = []; if (!state.visited.includes(state.location)) state.visited.push(state.location); }
  if (delta.relationships) {
    for (const k of Object.keys(delta.relationships)) {
      state.relationships[k] = clamp((state.relationships[k] || 0) + Number(delta.relationships[k] || 0), -100, 100);
    }
  }
  if (delta.quests) {
    if (!Array.isArray(state.quests)) state.quests = [];
    for (const q of (delta.quests.add || [])) { const t = String(q).slice(0, 140); if (t && !state.quests.some((x) => x.text === t)) state.quests.push({ text: t, done: false }); }
    for (const q of (delta.quests.done || [])) { const t = String(q); const hit = state.quests.find((x) => x.text === t || x.text.startsWith(t.slice(0, 18))); if (hit) hit.done = true; else state.quests.push({ text: t, done: true }); }
  }
  return state;
}

// Build a fresh run state from a Story Bible.
export const DIFFICULTY = {
  story: { label: "Story (forgiving)", dc: -3, hp: 1.3 },
  normal: { label: "Normal", dc: 0, hp: 1 },
  brutal: { label: "Brutal", dc: 3, hp: 0.75 },
};
export function diffOffset(mode) { return (DIFFICULTY[mode] || DIFFICULTY.normal).dc; }

export function newRunState(bible, seed, difficulty = "normal") {
  const p = bible.protagonist || {};
  const stats = Object.assign({ STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, p.stats || {});
  const con = stats.CON || 10;
  const hpMax = Math.max(6, Math.round((20 + mod(con) * 3) * (DIFFICULTY[difficulty] || DIFFICULTY.normal).hp));
  const loc = (bible.openingScene && bible.openingScene.locationId) || "";
  return {
    seed, turn: 0, difficulty,
    stats, skills: p.skills || {},
    hp: hpMax, hpMax, xp: 0, level: 1, statPoints: 0,
    gold: Number(p.gold || 0),
    inventory: Array.isArray(p.inventory) ? [...p.inventory] : [],
    flags: [], relationships: {}, quests: [], visited: loc ? [loc] : [],
    location: loc,
    history: [], // [{ turn, choiceText, check }]
    log: [], // full narrative log [{role:'scene'|'choice'|'roll', text}]
    recap: "", // short rolling "story so far" — keeps prompts tiny
    tokens: { prompt: 0, completion: 0, total: 0, cached: 0, last: 0, turns: 0 },
  };
}

// Maintain a compact rolling recap (last few beats) instead of resending history.
export function pushRecap(state, line) {
  const beats = state.recap ? state.recap.split(" | ") : [];
  beats.push(String(line).slice(0, 90));
  state.recap = beats.slice(-6).join(" | ");
  return state.recap;
}

// Fold an API usage object into the run's token meter.
export function addUsage(state, usage) {
  if (!usage) return;
  const p = Number(usage.prompt_tokens || 0);
  const comp = Number(usage.completion_tokens || 0);
  const tot = Number(usage.total_tokens || p + comp);
  const cached = Number(usage.prompt_cache_hit_tokens || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0);
  state.tokens.prompt += p;
  state.tokens.completion += comp;
  state.tokens.total += tot;
  state.tokens.cached += cached;
  state.tokens.last = tot;
  state.tokens.turns += 1;
}
