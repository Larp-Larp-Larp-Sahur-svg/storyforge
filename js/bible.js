// bible.js — The Story Bible: the structured world the AI extracts ONCE from your novel.
// After the scan, the game runs off this object + the pure-math engine.

export const DEFAULT_STAT_SCHEMA = [
  { key: "STR", label: "Strength", min: 3, max: 20, desc: "Physical power, melee, forcing things" },
  { key: "DEX", label: "Dexterity", min: 3, max: 20, desc: "Agility, stealth, reflexes, aim" },
  { key: "CON", label: "Constitution", min: 3, max: 20, desc: "Stamina, health, resisting harm" },
  { key: "INT", label: "Intellect", min: 3, max: 20, desc: "Reasoning, lore, deduction" },
  { key: "WIS", label: "Wisdom", min: 3, max: 20, desc: "Perception, intuition, willpower" },
  { key: "CHA", label: "Charisma", min: 3, max: 20, desc: "Persuasion, deceit, presence" },
];

export function emptyBible() {
  return {
    title: "",
    logline: "",
    tone: [],
    genres: [],
    setting: { world: "", era: "", locations: [] },
    protagonist: { name: "", desc: "", stats: {}, skills: {}, inventory: [], gold: 0 },
    characters: [],
    factions: [],
    items: [],
    themes: [],
    keyEvents: [],
    openingScene: { locationId: "", summary: "", situation: "" },
    statSchema: DEFAULT_STAT_SCHEMA,
    scanReport: { coverage: 0, found: [], missing: [], confidence: "none", notes: "" },
  };
}

// The JSON contract we ask the model to fill. Kept compact for cheap/free models.
export const BIBLE_INSTRUCTIONS = `You are a story-systems analyst. Read the SOURCE NOVEL/TEXT and extract a STORY BIBLE as STRICT JSON (no prose, no markdown fences). Schema:
{
  "title": string,
  "logline": string,
  "tone": string[],
  "genres": string[],
  "setting": { "world": string, "era": string, "locations": [{ "id": string, "name": string, "desc": string }] },
  "protagonist": { "name": string, "desc": string, "stats": { "STR":int,"DEX":int,"CON":int,"INT":int,"WIS":int,"CHA":int }, "skills": { [name:string]: int }, "inventory": string[], "gold": int },
  "characters": [{ "id": string, "name": string, "role": string, "desc": string, "disposition": int(-100..100) }],
  "factions": [{ "id": string, "name": string, "goal": string, "disposition": int(-100..100) }],
  "items": [{ "id": string, "name": string, "desc": string, "effect": string }],
  "themes": string[],
  "keyEvents": [{ "id": string, "summary": string }],
  "openingScene": { "locationId": string, "summary": string, "situation": string },
  "scanReport": { "coverage": int(0..100), "found": string[], "missing": string[], "confidence": "low"|"medium"|"high", "notes": string }
}
Rules: stats are integers 3..18 reflecting the protagonist's portrayal. Infer sensibly when the text is silent and note it in scanReport.missing. Keep ids short snake_case. Output ONLY the JSON object.`;

// Validate the extracted bible and produce a human-readable audit.
export function auditBible(b) {
  const issues = [];
  const good = [];
  const need = (cond, okMsg, badMsg) => (cond ? good.push(okMsg) : issues.push(badMsg));

  need(b && b.title, `Title: "${b && b.title}"`, "No title detected");
  need(b && b.logline && b.logline.length > 10, "Logline captured", "Logline missing/too short");
  need(b && b.protagonist && b.protagonist.name, `Protagonist: ${b && b.protagonist && b.protagonist.name}`, "No protagonist identified");
  const locs = (b && b.setting && b.setting.locations) || [];
  need(locs.length >= 1, `${locs.length} location(s)`, "No locations found");
  need((b && b.characters || []).length >= 1, `${(b && b.characters || []).length} character(s)`, "No supporting characters found");
  need(b && b.openingScene && b.openingScene.situation, "Opening scene set", "No opening scene/situation");
  const stats = (b && b.protagonist && b.protagonist.stats) || {};
  const hasStats = ["STR", "DEX", "CON", "INT", "WIS", "CHA"].every((k) => Number.isFinite(Number(stats[k])));
  need(hasStats, "Full stat block derived", "Incomplete stat block (defaults applied)");

  // Coverage score: blend model self-report with our structural checks.
  const structural = Math.round((good.length / (good.length + issues.length || 1)) * 100);
  const reported = Number((b && b.scanReport && b.scanReport.coverage) || 0);
  const coverage = Math.round((structural * 0.6 + reported * 0.4));
  const ok = issues.length === 0 || (coverage >= 60 && b && b.protagonist && b.protagonist.name);
  return { ok, coverage, good, issues, report: (b && b.scanReport) || {} };
}

// Repair a bible so the engine never crashes on a partial scan.
export function normalizeBible(b) {
  const base = emptyBible();
  const out = Object.assign(base, b || {});
  out.setting = Object.assign(base.setting, (b && b.setting) || {});
  if (!Array.isArray(out.setting.locations) || !out.setting.locations.length) {
    out.setting.locations = [{ id: "start", name: "The Threshold", desc: "Where the story begins." }];
  }
  out.protagonist = Object.assign(base.protagonist, (b && b.protagonist) || {});
  out.protagonist.stats = Object.assign({ STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, out.protagonist.stats || {});
  if (!out.protagonist.name) out.protagonist.name = "The Wanderer";
  for (const key of ["characters", "factions", "items", "themes", "keyEvents", "tone", "genres"]) {
    if (!Array.isArray(out[key])) out[key] = [];
  }
  out.openingScene = Object.assign(base.openingScene, (b && b.openingScene) || {});
  if (!out.openingScene.locationId) out.openingScene.locationId = out.setting.locations[0].id;
  if (!out.openingScene.situation) out.openingScene.situation = "You stand at the start of the tale, the world unwritten before you.";
  if (!out.statSchema || !out.statSchema.length) out.statSchema = DEFAULT_STAT_SCHEMA;
  return out;
}
