// ai.js — Model adapter, token-optimized, with multi-key rotation + offline baking.
// ONE scan call audits the novel into a Story Bible. Each turn, narrate() writes
// prose + choices; the math engine resolves mechanics. The AI never decides success.

import { BIBLE_INSTRUCTIONS } from "./bible.js";

const STATS = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function extractJson(text) {
  if (!text) throw new Error("Empty model response");
  let t = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in response");
  let slice = t.slice(start, end + 1);
  try { return JSON.parse(slice); }
  catch { return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")); }
}

// Low-level OpenAI-compatible chat call. Returns { content, usage }.
export async function chat(settings, messages, { json = false, maxTokens } = {}) {
  const url = settings.base.replace(/\/$/, "") + "/chat/completions";
  const headers = { "Content-Type": "application/json" };
  if (settings.apiKey) headers["Authorization"] = "Bearer " + settings.apiKey;
  const body = {
    model: settings.model,
    messages,
    temperature: Number(settings.temperature ?? 1.0),
    max_tokens: Number(maxTokens || settings.maxTokens || 450),
  };
  if (json) body.response_format = { type: "json_object" };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error(`API ${res.status}: ${txt.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  return { content: (msg && (msg.content || "")) || "", usage: data.usage || null };
}

// ---- MULTI-KEY ROTATION POOL ------------------------------------------------
let _cursor = 0;
const _cooldown = new Map();
const _kid = (e) => (e.base || "") + "|" + (e.model || "") + "|" + (e.apiKey || "").slice(-6);
export function hostOf(base) { try { return new URL(base).host.replace(/^api\./, ""); } catch { return base || "local"; } }

export function endpointsFrom(s) {
  const out = [], seen = new Set();
  const add = (b, m, k) => { if (!b || !m) return; const id = b + "|" + m + "|" + (k || ""); if (seen.has(id)) return; seen.add(id); out.push({ base: b, model: m, apiKey: k || "" }); };
  add(s.base, s.model, s.apiKey);
  for (const e of (s.pool || [])) add(e.base || s.base, e.model || s.model, e.apiKey);
  return out;
}

function _retryable(err) { const st = err && err.status; return !st || st === 429 || st === 402 || st === 408 || st === 409 || st >= 500; }

export async function chatPooled(settings, messages, opts) {
  const eps = endpointsFrom(settings);
  if (!eps.length) return chat(settings, messages, opts);
  let lastErr;
  for (let i = 0; i < eps.length; i++) {
    const e = eps[(_cursor + i) % eps.length];
    if ((_cooldown.get(_kid(e)) || 0) > Date.now()) continue;
    try {
      const r = await chat({ ...settings, base: e.base, model: e.model, apiKey: e.apiKey }, messages, opts);
      _cursor = (_cursor + i + 1) % eps.length;
      r.endpoint = e;
      return r;
    } catch (err) {
      lastErr = err;
      if (_retryable(err)) { _cooldown.set(_kid(e), Date.now() + (err.status === 429 ? 45000 : 12000)); continue; }
      throw err;
    }
  }
  throw lastErr || new Error("All keys are rate-limited right now — add more keys or wait a moment.");
}

// THE ONE-TIME SCAN. Chunks long novels, audits each, then merges.
export async function scanNovel(settings, novelText, onProgress = () => {}) {
  if (settings.provider === "offline") return { bible: offlineScan(novelText, onProgress), usage: null };
  const text = String(novelText || "").trim();
  if (!text) throw new Error("No source text provided");
  const MAX = 14000;
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
  onProgress(`Auditing ${text.length.toLocaleString()} chars in ${chunks.length} pass(es)…`);
  let bible = null, tot = 0;
  for (let i = 0; i < chunks.length; i++) {
    onProgress(`Scan pass ${i + 1}/${chunks.length}…`);
    const priorCtx = bible ? `Partial bible so far (MERGE, keep prior, refine): ${JSON.stringify(bible).slice(0, 3500)}` : "";
    const messages = [
      { role: "system", content: BIBLE_INSTRUCTIONS },
      { role: "user", content: `${priorCtx}\n\nSOURCE (part ${i + 1}/${chunks.length}):\n\n${chunks[i]}` },
    ];
    const { content, usage } = await chatPooled(settings, messages, { json: true, maxTokens: 1800 });
    tot += (usage && usage.total_tokens) || 0;
    const parsed = extractJson(content);
    bible = bible ? mergeBibles(bible, parsed) : parsed;
  }
  onProgress(`Scan complete— ${tot ? tot.toLocaleString() + " tokens" : "done"}.`);
  return { bible, usage: { total_tokens: tot } };
}

function mergeBibles(a, b) {
  const byId = (arr) => { const m = {}; for (const x of arr || []) m[x.id || x.name] = x; return m; };
  const mergeArr = (x, y) => Object.values(Object.assign(byId(x), byId(y)));
  return {
    title: b.title || a.title,
    logline: (b.logline && b.logline.length > (a.logline || "").length) ? b.logline : a.logline,
    tone: [...new Set([...(a.tone || []), ...(b.tone || [])])],
    genres: [...new Set([...(a.genres || []), ...(b.genres || [])])],
    setting: {
      world: b.setting?.world || a.setting?.world || "",
      era: b.setting?.era || a.setting?.era || "",
      locations: mergeArr(a.setting?.locations, b.setting?.locations),
    },
    protagonist: a.protagonist?.name ? a.protagonist : b.protagonist,
    characters: mergeArr(a.characters, b.characters),
    factions: mergeArr(a.factions, b.factions),
    items: mergeArr(a.items, b.items),
    themes: [...new Set([...(a.themes || []), ...(b.themes || [])])],
    keyEvents: mergeArr(a.keyEvents, b.keyEvents),
    openingScene: a.openingScene?.situation ? a.openingScene : b.openingScene,
    scanReport: {
      coverage: Math.max(a.scanReport?.coverage || 0, b.scanReport?.coverage || 0),
      found: [...new Set([...(a.scanReport?.found || []), ...(b.scanReport?.found || [])])],
      missing: [...new Set([...(a.scanReport?.missing || []), ...(b.scanReport?.missing || [])])],
      confidence: b.scanReport?.confidence || a.scanReport?.confidence || "medium",
      notes: [a.scanReport?.notes, b.scanReport?.notes].filter(Boolean).join(" "),
    },
  };
}

// ---- the STATIC GM system prompt (identical every turn => cache-friendly) ----
const GM_SYS = `You are the Game Master of an endless, branching interactive novel built from the STORY BIBLE in the next message. Continue with ORIGINAL, surprising beats that honor the world, tone and characters — never retell the source. Be cinematic yet economical: vivid concrete sensory detail, real stakes, momentum, distinct character voices; vary pacing and DO NOT repeat earlier phrasings or offered actions.
Return STRICT JSON only, no prose, no code fences, using these SHORT keys:
{"scene":"2-3 tight second-person paragraphs","delta":{"hp":0,"xp":0,"gold":0,"add":[],"drop":[],"flags":[],"loc":"","rel":{},"stat":{},"q":{"a":[],"d":[]}},"choices":[{"id":"a","t":"a distinct action","s":"STR|DEX|CON|INT|WIS|CHA","b":0,"dc":12,"r":"what failure costs"}]}
Give exactly 3 choices (4 only at major forks), each a different approach tied to ONE stat. dc scale: 8 easy, 12 moderate, 16 hard, 20 severe. Award small xp (5-15) for progress. Use "q" to add new objectives (a) or mark goals just completed (d) — only when they actually change; weave them into the story naturally. flags can track conditions (e.g. "wounded","hunted","blessed"). Only fill delta fields that change; omit or 0 the rest. NEVER state whether a check succeeds — the engine rolls the dice. Keep it concise to save tokens.`;

// Compact, STABLE bible string (same across the whole run => cached prefix).
function compactBible(b, depth = "full") {
  const lean = depth === "lean";
  const j = {
    title: b.title, logline: (b.logline || "").slice(0, lean ? 120 : 200),
    tone: (b.tone || []).slice(0, lean ? 3 : 5), genres: (b.genres || []).slice(0, 3),
    world: b.setting?.world || "", era: lean ? undefined : (b.setting?.era || ""),
    locs: (b.setting?.locations || []).slice(0, lean ? 6 : 10).map((l) => `${l.id}:${l.name}`),
    hero: `${b.protagonist?.name || ""} — ${(b.protagonist?.desc || "").slice(0, lean ? 80 : 120)}`,
    cast: (b.characters || []).slice(0, lean ? 5 : 10).map((c) => `${c.id}:${c.name}${c.role ? "(" + c.role + ")" : ""}`),
    factions: (b.factions || []).slice(0, lean ? 3 : 6).map((f) => `${f.name}${f.goal ? "→" + String(f.goal).slice(0, 50) : ""}`),
    items: (b.items || []).slice(0, lean ? 6 : 12).map((i) => i.name),
    themes: (b.themes || []).slice(0, lean ? 3 : 5),
  };
  return "STORY BIBLE:\n" + JSON.stringify(j);
}

function statLine(s) { return STATS.map((k) => `${k}${s.stats[k] ?? 10}`).join(" "); }
function stateDigest(s) {
  return `T${s.turn} @${s.location || "?"} HP${s.hp}/${s.hpMax} L${s.level} XP${s.xp} ${s.gold}g | ${statLine(s)} | inv:${s.inventory.join(",") || "-"} | flags:${s.flags.join(",") || "-"}`;
}

// Expand short model keys back into the canonical shape the engine/app expect.
function expand(out) {
  const d = out.delta || out.stateDelta || {};
  const stateDelta = {
    hp: d.hp, xp: d.xp, gold: d.gold,
    addItems: d.add || d.addItems, removeItems: d.drop || d.removeItems, addFlags: d.flags || d.addFlags,
    location: d.loc || d.location, relationships: d.rel || d.relationships, stats: d.stat || d.stats,
  };
  if (d.q || d.quests) { const q = d.q || d.quests; stateDelta.quests = { add: q.a || q.add || [], done: q.d || q.done || [] }; }
  const choices = (out.choices || []).slice(0, 4).map((c, i) => ({
    id: c.id || "c" + i,
    text: c.t || c.text || "Continue",
    stat: STATS.includes(c.s || c.stat) ? (c.s || c.stat) : "WIS",
    skill: "",
    skillBonus: Number(c.b ?? c.skillBonus ?? 0),
    difficulty: clampN(Number(c.dc ?? c.difficulty ?? 12), 5, 25),
    risk: c.r || c.risk || "",
  }));
  return { scene: out.scene || "", stateDelta, choices };
}

// Narrate the next beat. Returns { scene, choices, stateDelta, usage, via }.
export async function narrate(settings, bible, state, lastOutcome, onProgress = () => {}) {
  if (settings.provider === "offline") return offlineNarrate(bible, state, lastOutcome);
  const messages = [
    { role: "system", content: GM_SYS },
    { role: "system", content: compactBible(bible, settings.contextDepth || "full") },
  ];
  const goals = (state.quests || []).filter((q) => !q.done).slice(-2).map((q) => q.text).join("; ");
  let tail;
  if (state.turn === 0) {
    tail = `START the adventure. Opening: ${String(bible.openingScene?.situation || "").slice(0, 220)}\nSTATE: ${stateDigest(state)}${goals ? "\nGOALS: " + goals : ""}`;
  } else {
    const c = lastOutcome?.check || {};
    tail = `LAST: "${lastOutcome?.choiceText}" → ${c.degree} (d20 ${c.d20}, ${c.total} vs DC ${c.difficulty}).\nSO FAR: ${state.recap || "(start)"}\nSTATE: ${stateDigest(state)}${goals ? "\nGOALS: " + goals : ""}\nWrite the consequence + 3 new choices.`;
  }
  messages.push({ role: "user", content: tail });
  onProgress("Narrating…");
  const { content, usage, endpoint } = await chatPooled(settings, messages, { json: true, maxTokens: settings.maxTokens || 450 });
  const out = expand(extractJson(content));
  out.usage = usage;
  out.via = endpoint ? hostOf(endpoint.base) : null;
  return out;
}

// ---------- OFFLINE template engine (zero network, pure procedural) ----------
function offlineScan(text, onProgress) {
  onProgress("Offline audit (no AI): deriving a bible from the text…");
  const t = String(text || "");
  const caps = [...t.matchAll(/\b([A-Z][a-z]{2,})\b/g)].map((m) => m[1]);
  const freq = {};
  for (const w of caps) freq[w] = (freq[w] || 0) + 1;
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).map((x) => x[0]).filter((w) => !["The", "And", "But", "She", "His", "Her", "They", "When", "Then", "There"].includes(w));
  const hero = top[0] || "The Wanderer";
  const firstLine = (t.split(/\n|\./).find((s) => s.trim().length > 20) || "A story begins.").trim();
  return {
    title: top[0] ? `The Tale of ${top[0]}` : "Untitled Saga",
    logline: firstLine.slice(0, 160),
    tone: ["adventurous", "mysterious"], genres: ["adventure"],
    setting: { world: top[1] ? `${top[1]}` : "an unnamed land", era: "unknown", locations: [{ id: "start", name: top[1] || "The Crossing", desc: "Where the journey opens." }] },
    protagonist: { name: hero, desc: "The protagonist drawn from your text.", stats: { STR: 11, DEX: 12, CON: 11, INT: 13, WIS: 12, CHA: 11 }, skills: {}, inventory: ["travel pack"], gold: 5 },
    characters: top.slice(1, 6).map((n, i) => ({ id: "c" + i, name: n, role: "figure from the tale", desc: "", disposition: 0 })),
    factions: [], items: [], themes: ["the journey"], keyEvents: [],
    openingScene: { locationId: "start", summary: firstLine.slice(0, 120), situation: firstLine },
    scanReport: { coverage: 55, found: ["protagonist", "named figures", "opening line"], missing: ["AI provider not used — offline heuristic only; connect an AI for a full audit"], confidence: "low", notes: "Offline heuristic scan. Connect a free AI provider for a deep, structured audit." },
  };
}

const OFFLINE_BEATS = [
  (b, s) => `The path through ${locName(b, s)} narrows. ${pName(b)} feels the weight of every prior choice. Something stirs ahead — opportunity wearing the mask of danger.`,
  (b, s) => `A stranger blocks the way, eyes measuring ${pName(b)}. Words could open a door here — or steel could.`,
  (b, s) => `The ground gives a hollow sound. Below, faint light leaks from a place that should not be lit. Curiosity and caution war within you.`,
  (b, s) => `Rumor and memory collide: one of the tale's old powers has noticed your passage. The next move will echo.`,
];
function pName(b) { return b.protagonist?.name || "you"; }
function locName(b, s) { const l = (b.setting?.locations || []).find((x) => x.id === s.location); return l ? l.name : "the wild"; }
function offlineNarrate(bible, state, lastOutcome) {
  const beat = OFFLINE_BEATS[state.turn % OFFLINE_BEATS.length];
  const scene = state.turn === 0
    ? `${bible.openingScene?.situation || "Your story begins."}\n\nYou are ${pName(bible)}. The world of ${bible.setting?.world || "the tale"} waits.`
    : `${outcomeLine(lastOutcome)}\n\n${beat(bible, state)}`;
  const choices = [
    { id: "force", text: "Force your way through directly", stat: "STR", skill: "", skillBonus: 0, difficulty: 13, risk: "injury" },
    { id: "slip", text: "Move quietly and unseen", stat: "DEX", skill: "", skillBonus: 0, difficulty: 12, risk: "being caught" },
    { id: "reason", text: "Study the situation and reason it out", stat: "INT", skill: "", skillBonus: 0, difficulty: 11, risk: "lost time" },
  ];
  const delta = { xp: 8 + (lastOutcome?.check?.success ? 6 : 0), hp: lastOutcome?.check?.success === false ? -3 : 0 };
  return { scene, choices, stateDelta: delta, usage: null };
}
function outcomeLine(o) {
  if (!o) return "You press onward.";
  const c = o.check || {};
  if (c.degree === "critical success") return `Brilliant — your attempt to ${o.choiceText.toLowerCase()} goes perfectly.`;
  if (c.success) return `You manage to ${o.choiceText.toLowerCase()}.`;
  if (c.degree === "critical failure" || c.degree === "disaster") return `Disaster — trying to ${o.choiceText.toLowerCase()} backfires badly.`;
  return `Your attempt to ${o.choiceText.toLowerCase()} falls short.`;
}

// ============================================================================
//  OFFLINE STORY COMPILER — "Bake" a whole branching gamebook ahead of time.
//  Loops over every open branch, generating nodes until complete (or capped),
//  so the finished story plays fully offline with ZERO further API calls.
// ============================================================================
const NODE_SYS = `You are compiling a branching gamebook from the STORY BIBLE. For the given situation, output ONE node as STRICT JSON (no fences):
{"scene":"2-3 vivid second-person paragraphs","end":false,"choices":[{"t":"a distinct action","s":"STR|DEX|CON|INT|WIS|CHA","b":0,"dc":12,"r":"risk if it fails"}]}
Normally give 3 choices that diverge meaningfully. For a conclusion (victory, death, twist, resolution) set "end":true with an empty choices array. Honor the world/tone; never repeat earlier phrasing. Be concise.`;

function normChoiceBake(c) {
  return {
    text: c.t || c.text || "Continue",
    stat: STATS.includes(c.s || c.stat) ? (c.s || c.stat) : "WIS",
    skillBonus: Number(c.b ?? c.skillBonus ?? 0),
    difficulty: clampN(Number(c.dc ?? c.difficulty ?? 12), 5, 25),
    risk: c.r || c.risk || "",
  };
}

export async function bakeNode(settings, bible, ctx) {
  if (settings.provider === "offline") return offlineNode(bible, ctx);
  const messages = [
    { role: "system", content: NODE_SYS },
    { role: "system", content: compactBible(bible, settings.contextDepth || "full") },
    { role: "user", content: ctx },
  ];
  const { content, usage } = await chatPooled(settings, messages, { json: true, maxTokens: settings.maxTokens || 450 });
  const o = extractJson(content);
  return { scene: o.scene || "", end: !!o.end, choices: (o.choices || []).slice(0, 3).map(normChoiceBake), usage };
}

// Returns { rootId, nodes, count, tokens }. onProgress(msg, pct) reports live status.
export async function bakeStory(settings, bible, opts = {}, onProgress = () => {}) {
  const maxNodes = Math.max(8, Math.min(400, opts.maxNodes || 60));
  const nodes = {};
  let counter = 0, tokens = 0, made = 0;
  const nid = () => "n" + counter++;

  onProgress("Opening scene…", 1);
  const rootId = nid();
  const root = await bakeNode(settings, bible, `START the adventure. Opening: ${String(bible.openingScene?.situation || "").slice(0, 220)}`);
  tokens += (root.usage && root.usage.total_tokens) || 0;
  nodes[rootId] = { id: rootId, scene: root.scene, end: root.end, choices: root.choices.map((c) => ({ ...c, to: null })) };
  made = 1;
  const frontier = [];
  if (!root.end) root.choices.forEach((c, i) => frontier.push({ parentId: rootId, idx: i, choiceText: c.text, summary: root.scene.slice(0, 160) }));

  while (frontier.length && made < maxNodes) {
    const it = frontier.shift();
    const forceEnd = made >= maxNodes - 3;
    onProgress(`Expanding node ${made}/${maxNodes} · ${frontier.length} branches queued · ${tokens.toLocaleString()} tok`, Math.round((made / maxNodes) * 100));
    let node;
    try {
      node = await bakeNode(settings, bible, `Previously: ${it.summary}\nThe player chose: "${it.choiceText}". Write the resulting node.${forceEnd ? " This MUST be an ENDING (end:true, choices:[])." : ""}`);
    } catch (e) { node = { scene: `The path falters here. (${e.message})`, end: true, choices: [] }; }
    tokens += (node.usage && node.usage.total_tokens) || 0;
    const cid = nid();
    const isEnd = node.end || forceEnd;
    nodes[cid] = { id: cid, scene: node.scene, end: isEnd, choices: isEnd ? [] : node.choices.map((c) => ({ ...c, to: null })) };
    nodes[it.parentId].choices[it.idx].to = cid;
    made++;
    if (!isEnd) node.choices.forEach((c, i) => frontier.push({ parentId: cid, idx: i, choiceText: c.text, summary: node.scene.slice(0, 160) }));
  }
  const endId = nid();
  nodes[endId] = { id: endId, scene: "The threads of fate draw shut here, and your tale finds its rest — for now.", end: true, choices: [] };
  let dangling = false;
  for (const n of Object.values(nodes)) for (const c of n.choices) if (c.to == null) { c.to = endId; dangling = true; }
  if (!dangling) delete nodes[endId];
  onProgress(`Done — ${Object.keys(nodes).length} nodes, ${tokens.toLocaleString()} tokens.`, 100);
  return { rootId, nodes, count: Object.keys(nodes).length, tokens, bakedAt: Date.now() };
}

function offlineNode(bible, ctx) {
  if (/ENDING/.test(ctx)) return { scene: `A hush falls over ${bible.setting?.world || "the land"}. This chapter of ${bible.protagonist?.name || "the hero"} closes.`, end: true, choices: [], usage: null };
  const beat = OFFLINE_BEATS[ctx.length % OFFLINE_BEATS.length](bible, { location: "start" });
  return {
    scene: beat, end: false, usage: null,
    choices: [
      { text: "Press forward boldly", stat: "STR", skillBonus: 0, difficulty: 13, risk: "injury" },
      { text: "Take the subtle path", stat: "DEX", skillBonus: 0, difficulty: 12, risk: "exposure" },
      { text: "Seek another way", stat: "INT", skillBonus: 0, difficulty: 11, risk: "delay" },
    ],
  };
}
