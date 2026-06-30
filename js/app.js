// app.js — StoryForge controller: Library · Setup · Audit · Play + Codex/Runs overlays.
import { PROVIDERS, DEFAULT_SETTINGS, LENGTHS } from "./config.js";
import { auditBible, normalizeBible } from "./bible.js";
import { scanNovel, narrate, bakeStory } from "./ai.js";
import * as E from "./engine.js";
import * as Lib from "./library.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const SETTINGS_KEY = "sf.settings";
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};

let settings = Object.assign({}, DEFAULT_SETTINGS, store.get(SETTINGS_KEY, {}));
let lib = Lib.loadLib();
let activeStoryId = null, activeRunId = null;
let bible = null, run = null, currentTurn = null;
let undoStack = [];
let bakedTree = null, bakeStoryId = null, deferredPrompt = null;

// ---------- routing & toast ----------
function show(id) { $$(".screen").forEach((s) => s.classList.add("hidden")); $("#" + id).classList.remove("hidden"); window.scrollTo(0, 0); }
function toast(msg, kind = "") {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show " + kind;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = "toast"), 3800);
}
function ago(ts) { const s = (Date.now() - ts) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; }

// ================= LIBRARY =================
function renderLibrary() {
  const q = ($("#libSearch").value || "").toLowerCase();
  let stories = Lib.listStories(lib);
  if (q) stories = stories.filter((s) => (s.title + " " + s.logline + " " + (s.tags || []).join(" ")).toLowerCase().includes(q));
  const grid = $("#storyGrid");
  $("#libEmpty").classList.toggle("hidden", Lib.listStories(lib).length > 0);
  grid.innerHTML = stories.map((s) => {
    const runs = Lib.runsForStory(lib, s.id);
    const tok = runs.reduce((a, r) => a + ((r.run && r.run.tokens && r.run.tokens.total) || 0), 0);
    const last = runs[0];
    return `<div class="story-card" data-story="${s.id}">
      <div class="sc-cover">${esc(s.cover || "S")}</div>
      <div class="sc-body">
        <h3 class="sc-title">${esc(s.title)}${s.baked ? ` <span class="badge">OFFLINE · ${s.baked.count}</span>` : ""}</h3>
        <p class="sc-log">${esc((s.logline || "").slice(0, 120))}</p>
        <div class="chips">${(s.tags || []).slice(0, 4).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
        <div class="sc-meta">${runs.length} save${runs.length === 1 ? "" : "s"} · ${last ? "played " + ago(last.updatedAt) : "new"}${tok ? " · " + tok.toLocaleString() + " tok" : ""}</div>
      </div>
      <div class="sc-actions">
        <button class="btn primary sm" data-act="play">${s.baked ? "Play offline" : "Play"}</button>
        <button class="btn ghost sm" data-act="runs">Saves</button>
        <button class="btn ghost sm" data-act="bake">${s.baked ? "Re-bake" : "Download offline"}</button>
        <button class="btn ghost sm" data-act="rename">Rename</button>
        <button class="btn ghost sm" data-act="dup">Duplicate</button>
        <button class="btn ghost sm" data-act="export">Export</button>
        <button class="btn ghost sm" data-act="del">Delete</button>
      </div></div>`;
  }).join("");
}

function handleLibAction(act, storyId) {
  const s = lib.stories[storyId];
  if (!s) return;
  if (act === "play") return play(storyId);
  if (act === "bake") return openBake(storyId);
  if (act === "runs") return openRuns(storyId);
  if (act === "rename") { const n = prompt("Story title:", s.title); if (n) { Lib.updateStory(lib, storyId, { title: n.trim(), cover: n.trim()[0]?.toUpperCase() || "S" }); renderLibrary(); } return; }
  if (act === "dup") { Lib.duplicateStory(lib, storyId); renderLibrary(); toast("Story duplicated.", "ok"); return; }
  if (act === "export") return exportStory(storyId);
  if (act === "del") { if (confirm(`Delete "${s.title}" and all its saves? This cannot be undone.`)) { Lib.deleteStory(lib, storyId); renderLibrary(); toast("Story deleted."); } return; }
}

function playStory(storyId) {
  activeStoryId = storyId;
  bible = normalizeBible(lib.stories[storyId].bible);
  const latest = Lib.latestRun(lib, storyId);
  if (latest) { activeRunId = latest.id; run = latest.run; }
  else { run = E.newRunState(bible, String(Date.now()), settings.difficulty); activeRunId = Lib.createRun(lib, storyId, run, "Save 1"); }
  undoStack = [];
  openPlay();
}

function exportStory(storyId) {
  const s = lib.stories[storyId];
  const data = { type: "storyforge-story", story: { title: s.title, bible: s.bible, tags: s.tags }, runs: Lib.runsForStory(lib, storyId).map((r) => ({ name: r.name, run: r.run })) };
  downloadJson(data, (s.title || "story").replace(/\W+/g, "_") + ".storyforge.json");
}
function importStory(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      const b = normalizeBible(d.story?.bible || d.bible);
      const sid = Lib.createStory(lib, b);
      if (d.story?.title) Lib.updateStory(lib, sid, { title: d.story.title });
      const runs = d.runs || (d.run ? [{ name: "Imported", run: d.run }] : []);
      for (const rr of runs) if (rr.run) Lib.createRun(lib, sid, rr.run, rr.name || "Imported");
      renderLibrary(); toast("Story imported.", "ok");
    } catch (e) { toast("Could not import: " + e.message, "err"); }
  };
  r.readAsText(file);
}

// ================= RUNS / SAVE SLOTS =================
function openRuns(storyId) {
  activeStoryId = storyId;
  const s = lib.stories[storyId];
  $("#runsTitle").textContent = `Saves — ${s.title}`;
  const runs = Lib.runsForStory(lib, storyId);
  $("#runsList").innerHTML = runs.length ? runs.map((r) => {
    const rn = r.run || {};
    return `<div class="run-row" data-run="${r.id}">
      <div><b>${esc(r.name)}</b><div class="muted sm">Turn ${rn.turn || 0} · Lv ${rn.level || 1} · ${ago(r.updatedAt)}</div></div>
      <div class="run-acts"><button class="btn primary sm" data-ract="continue">Continue</button><button class="btn ghost sm" data-ract="rename">Rename</button><button class="btn ghost sm" data-ract="del">Delete</button></div></div>`;
  }).join("") : `<p class="muted">No saves yet.</p>`;
  $("#runsModal").classList.remove("hidden");
}
function handleRunAction(ract, runId) {
  const rec = lib.runs[runId];
  if (!rec) return;
  if (ract === "continue") { $("#runsModal").classList.add("hidden"); activeStoryId = rec.storyId; activeRunId = runId; bible = normalizeBible(lib.stories[rec.storyId].bible); bakedTree = lib.stories[rec.storyId].baked || null; run = rec.run; undoStack = []; openPlay(); return; }
  if (ract === "rename") { const n = prompt("Save name:", rec.name); if (n) { Lib.renameRun(lib, runId, n.trim()); openRuns(rec.storyId); } return; }
  if (ract === "del") { if (confirm(`Delete save "${rec.name}"?`)) { Lib.deleteRun(lib, runId); openRuns(rec.storyId); renderLibrary(); } return; }
}

// ================= SETUP / SCAN =================
function renderProviders() {
  const sel = $("#provider");
  sel.innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join("");
  sel.value = settings.provider;
  applyProvider(settings.provider, true);
  sel.onchange = () => applyProvider(sel.value);
  $("#base").value = settings.base; $("#model").value = settings.model;
  $("#apiKey").value = settings.apiKey || ""; $("#temp").value = settings.temperature;
  if ($("#keyPool")) $("#keyPool").value = settings.poolText || "";
  if ($("#difficulty")) $("#difficulty").value = settings.difficulty || "normal";
  const len = $("#length");
  len.innerHTML = Object.entries(LENGTHS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  len.value = settings.length || "normal";
}
function applyProvider(key, keep) {
  const p = PROVIDERS[key];
  if (!keep && key !== "custom") { $("#base").value = p.base; $("#model").value = p.model; }
  $("#provNote").innerHTML = p.note + (p.keyUrl ? ` — <a href="${p.keyUrl}" target="_blank" rel="noopener">get a key</a>` : "");
  $("#keyRow").style.display = p.needsKey ? "" : "none";
  settings.provider = key;
}
function parsePool(text, fb) {
  return String(text || "").split(/\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const p = line.split(/\s*[|,]\s*/);
    if (p.length >= 3) return { base: p[0], model: p[1], apiKey: p.slice(2).join(",") };
    if (p.length === 2) return { base: fb.base, model: p[0], apiKey: p[1] };
    return { base: fb.base, model: fb.model, apiKey: p[0] };
  });
}
function collectSettings() {
  settings.provider = $("#provider").value;
  settings.base = $("#base").value.trim();
  settings.model = $("#model").value.trim();
  settings.apiKey = $("#apiKey").value.trim();
  settings.temperature = Number($("#temp").value);
  settings.length = $("#length").value || "normal";
  settings.maxTokens = (LENGTHS[settings.length] || LENGTHS.normal).tokens;
  settings.difficulty = ($("#difficulty") && $("#difficulty").value) || settings.difficulty || "normal";
  if (settings.economy) settings.maxTokens = LENGTHS.lean.tokens;
  settings.poolText = ($("#keyPool") && $("#keyPool").value) || "";
  settings.pool = parsePool(settings.poolText, settings);
  store.set(SETTINGS_KEY, settings);
}

async function doScan() {
  collectSettings();
  const text = $("#novel").value.trim();
  if (!text) return toast("Paste or load a novel first.", "err");
  const haveKey = settings.apiKey || (settings.pool && settings.pool.some((e) => e.apiKey));
  if (PROVIDERS[settings.provider].needsKey && !haveKey) return toast("This provider needs an API key.", "err");
  const btn = $("#scanBtn"); btn.disabled = true;
  $("#scanLog").classList.remove("hidden");
  try {
    const { bible: raw } = await scanNovel(settings, text, (m) => ($("#scanLogText").textContent = m));
    bible = normalizeBible(raw);
    renderAudit(); show("audit");
  } catch (e) { toast("Scan failed: " + e.message, "err"); $("#scanLogText").textContent = e.message; }
  finally { btn.disabled = false; }
}

// ================= AUDIT =================
function renderAudit() {
  const a = auditBible(bible);
  $("#coverBar").style.width = a.coverage + "%";
  $("#coverPct").textContent = a.coverage + "%";
  $("#auditTitle").textContent = bible.title || "(untitled)";
  $("#auditLog").textContent = bible.logline || "";
  $("#foundList").innerHTML = a.good.map((g) => `<li class="ok">✓ ${esc(g)}</li>`).join("") + (a.report.found || []).map((g) => `<li class="ok">✓ ${esc(g)}</li>`).join("");
  $("#missList").innerHTML = (a.issues.length || (a.report.missing || []).length) ? a.issues.map((g) => `<li class="miss">! ${esc(g)}</li>`).join("") + (a.report.missing || []).map((g) => `<li class="miss">! ${esc(g)}</li>`).join("") : `<li class="ok">Clean scan.</li>`;
  $("#auditStats").innerHTML = Object.entries(bible.protagonist.stats).map(([k, v]) => `<span class="chip">${k} ${v}</span>`).join("");
  $("#auditCounts").innerHTML = [["Characters", bible.characters.length], ["Locations", bible.setting.locations.length], ["Factions", bible.factions.length], ["Items", bible.items.length], ["Themes", bible.themes.length], ["Events", bible.keyEvents.length]].map(([k, v]) => `<div class="count"><b>${v}</b><span>${k}</span></div>`).join("");
  $("#verdict").innerHTML = a.ok ? `<span class="ok">Scan usable — ready to forge.</span>` : `<span class="miss">Scan thin (${a.coverage}%). You can still play or re-scan.</span>`;
  $("#bibleJson").value = JSON.stringify(bible, null, 2);
}

function forgeFromAudit() {
  try { bible = normalizeBible(JSON.parse($("#bibleJson").value)); } catch {}
  activeStoryId = Lib.createStory(lib, bible);
  const seed = $("#seed").value.trim() || String(Date.now());
  run = E.newRunState(bible, seed, settings.difficulty);
  activeRunId = Lib.createRun(lib, activeStoryId, run, "Save 1");
  undoStack = [];
  openPlay();
}

// ================= PLAY =================
function openPlay() {
  show("play");
  if (run.baked && !bakedTree) bakedTree = (lib.stories[activeStoryId] || {}).baked || null;
  $("#storyLog").innerHTML = "";
  (run.log || []).forEach((l) => appendLog(l.role, esc(l.text).replace(/\n/g, "<br>")));
  renderHud();
  if (run.baked) { bakedShowCurrent(); }
  else if (run.pending && run.pending.choices) { currentTurn = run.pending; renderChoices(); }
  else nextBeat((run.history || []).slice(-1)[0] || null);
}

function persist() { if (activeRunId) Lib.saveRun(lib, activeRunId, run); }

function renderHud() {
  $("#hudName").textContent = bible.protagonist.name;
  $("#hudLoc").textContent = locName(run.location);
  $("#hudLevel").textContent = "Lv " + run.level;
  $("#hudTurn").textContent = "Turn " + run.turn;
  $("#hpFill").style.width = Math.round((run.hp / run.hpMax) * 100) + "%";
  $("#hpText").textContent = `${run.hp}/${run.hpMax}`;
  const base = run.level > 1 ? E.xpForLevel(run.level - 1) : 0;
  $("#xpFill").style.width = Math.round(((run.xp - base) / (E.xpForLevel(run.level) - base)) * 100) + "%";
  $("#xpText").textContent = `${run.xp} XP`;
  $("#statBlock").innerHTML = Object.entries(run.stats).map(([k, v]) => { const m = E.mod(v); return `<div class="stat"><span class="stat-k">${k}</span><span class="stat-v">${v}</span><span class="stat-m">${m >= 0 ? "+" : ""}${m}</span></div>`; }).join("");
  const sp = run.statPoints || 0;
  $("#pointsBlock").innerHTML = sp > 0 ? `<div class="points"><span>${sp} point${sp > 1 ? "s" : ""} to spend</span><div class="point-btns">${["STR", "DEX", "CON", "INT", "WIS", "CHA"].map((k) => `<button class="pt" data-stat="${k}">+${k}</button>`).join("")}</div></div>` : "";
  const qs = run.quests || [];
  $("#questBlock").innerHTML = qs.length ? qs.slice(-8).map((q) => `<div class="quest ${q.done ? "done" : ""}">${q.done ? "✓" : "•"} ${esc(q.text)}</div>`).join("") : `<span class="muted">none yet</span>`;
  $("#condBlock").innerHTML = (run.flags || []).length ? run.flags.map((f) => `<span class="chip">${esc(f)}</span>`).join("") : `<span class="muted">none</span>`;
  const places = (run.visited || []).map((id) => ({ id, name: locName(id) }));
  $("#placeBlock").innerHTML = places.length ? places.map((p) => `<span class="chip ${p.id === run.location ? "here" : ""}">${esc(p.name)}</span>`).join("") : `<span class="muted">—</span>`;
  $("#invBlock").innerHTML = run.inventory.length ? run.inventory.map((i) => `<span class="chip">${esc(i)}</span>`).join("") : `<span class="muted">empty</span>`;
  $("#goldBlock").textContent = run.gold + " gold";
  const rel = Object.entries(run.relationships);
  $("#relBlock").innerHTML = rel.length ? rel.map(([k, v]) => `<div class="rel"><span>${esc(charName(k))}</span><span>${v >= 0 ? "+" : ""}${v}</span></div>`).join("") : `<span class="muted">no bonds yet</span>`;
  const j = run.journey || {};
  const tries = (j.success || 0) + (j.fail || 0);
  $("#journeyBlock").innerHTML = `<div class="vital-row"><span>turns</span><span>${run.turn}</span></div><div class="vital-row"><span>crits / fumbles</span><span>${j.crits || 0} / ${j.fumbles || 0}</span></div><div class="vital-row"><span>success rate</span><span>${tries ? Math.round((j.success / tries) * 100) : 0}%</span></div>`;
  const t = run.tokens || {};
  const avg = t.turns ? Math.round(t.total / t.turns) : 0;
  $("#tokBlock").innerHTML = `<div class="vital-row"><span>last turn</span><span>${(t.last || 0).toLocaleString()}</span></div><div class="vital-row"><span>avg / turn</span><span>${avg.toLocaleString()}</span></div><div class="vital-row"><span>run total</span><span>${(t.total || 0).toLocaleString()}</span></div>` + (t.cached ? `<div class="vital-row"><span>cached</span><span>${Math.round((t.cached / t.prompt) * 100)}%</span></div>` : "") + (t.via ? `<div class="vital-row"><span>via</span><span>${esc(t.via)}</span></div>` : "");
}

function appendLog(role, html) { const el = document.createElement("div"); el.className = "beat " + role; el.innerHTML = html; $("#storyLog").appendChild(el); el.scrollIntoView({ behavior: "smooth", block: "end" }); }

async function nextBeat(lastOutcome) {
  setBusy(true);
  try {
    currentTurn = await narrate(settings, bible, run, lastOutcome, (m) => ($("#gmStatus").textContent = m));
    $("#gmStatus").textContent = "";
    if (currentTurn.stateDelta) E.applyDelta(run, currentTurn.stateDelta);
    E.addUsage(run, currentTurn.usage);
    if (currentTurn.via) run.tokens.via = currentTurn.via;
    run.log.push({ role: "scene", text: currentTurn.scene });
    run.pending = { scene: currentTurn.scene, choices: currentTurn.choices };
    appendLog("scene", esc(currentTurn.scene).replace(/\n/g, "<br>"));
    renderChoices(); renderHud();
    if (run.hp <= 0) return gameOver();
    persist();
  } catch (e) { toast("Narration failed: " + e.message, "err"); $("#gmStatus").textContent = e.message; }
  finally { setBusy(false); }
}

function renderChoices() {
  const box = $("#choices"); box.innerHTML = "";
  for (const c of currentTurn.choices) {
    const dc = c.difficulty + E.diffOffset(run.difficulty);
    const chance = E.odds(run.stats[c.stat] ?? 10, c.skillBonus, dc);
    const b = document.createElement("button");
    b.className = "choice";
    b.innerHTML = `<span class="choice-text">${esc(c.text)}</span><span class="choice-meta"><span class="tag">${c.stat}</span><span class="dc">DC ${dc}</span><span class="pct ${chance >= 65 ? "good" : chance >= 40 ? "warn" : "bad"}">${chance}%</span></span>${c.risk ? `<span class="risk">risk: ${esc(c.risk)}</span>` : ""}`;
    b.onclick = () => resolveChoice(c);
    box.appendChild(b);
  }
}

function resolveChoice(c) {
  if (run.baked) return bakedAdvance(c);
  undoStack.push({ run: clone(run), turn: clone(currentTurn) });
  if (undoStack.length > 20) undoStack.shift();
  const rng = E.rngFor(run.seed, run.turn, E.hashStr(c.id));
  const result = E.check(rng, run.stats[c.stat] ?? 10, c.skillBonus, c.difficulty + E.diffOffset(run.difficulty));
  run.turn += 1;
  if (!run.journey) run.journey = { crits: 0, fumbles: 0, success: 0, fail: 0 };
  if (result.crit) run.journey.crits++;
  if (result.fumble) run.journey.fumbles++;
  run.journey[result.success ? "success" : "fail"]++;
  run.history.push({ turn: run.turn, choiceText: c.text, check: result });
  run.log.push({ role: "choice", text: c.text });
  E.pushRecap(run, `${c.text}\u2192${result.degree}`);
  appendLog("choice", `<b>${esc(c.text)}</b>`);
  appendLog("roll", `<span class="${result.success ? "ok" : "miss"}">d20 ${result.d20} +mods → ${result.total} vs DC ${result.difficulty} — <b>${result.degree.toUpperCase()}</b></span>`);
  persist();
  nextBeat({ choiceText: c.text, check: result });
}

function freeAction(text) {
  if (!currentTurn) return;
  const c = { id: "free_" + run.turn, text: text.trim(), stat: "WIS", skill: "", skillBonus: 0, difficulty: 12, risk: "the unknown" };
  if (c.text) resolveChoice(c);
}

function rewind() {
  if (!undoStack.length) return toast("Nothing to rewind.");
  const prev = undoStack.pop();
  run = prev.run; currentTurn = prev.turn;
  $("#storyLog").innerHTML = "";
  (run.log || []).forEach((l) => appendLog(l.role, esc(l.text).replace(/\n/g, "<br>")));
  renderChoices(); renderHud(); persist();
  toast("Rewound one turn.", "ok");
}

function gameOver() {
  appendLog("scene", `<div class="gameover">Your story ends here — ${run.turn} turns, ${run.xp} XP. ${esc(bible.protagonist.name)} passes into legend.</div>`);
  $("#choices").innerHTML = `<button class="choice" id="restartBtn">Begin a new run</button>`;
  $("#restartBtn").onclick = () => { run = E.newRunState(bible, String(Date.now()), settings.difficulty); activeRunId = Lib.createRun(lib, activeStoryId, run, "Save " + (Lib.runsForStory(lib, activeStoryId).length + 1)); undoStack = []; openPlay(); };
  persist();
}
function setBusy(b) { $("#choices").classList.toggle("busy", b); $("#spinner").classList.toggle("hidden", !b); }

// ================= CODEX =================
function openCodex() {
  const sec = (title, items) => items && items.length ? `<h3>${title}</h3>` + items.join("") : "";
  const b = bible;
  const body =
    `<div class="codex-over"><h2>${esc(b.title)}</h2><p class="muted">${esc(b.logline)}</p>` +
    `<div class="chips">${[...(b.genres || []), ...(b.tone || [])].map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` +
    (b.setting?.world ? `<p class="sm"><b>World:</b> ${esc(b.setting.world)}${b.setting.era ? " · " + esc(b.setting.era) : ""}</p>` : "") +
    (b.themes?.length ? `<p class="sm"><b>Themes:</b> ${b.themes.map(esc).join(", ")}</p>` : "") + `</div>` +
    sec("Characters", (b.characters || []).map((c) => `<div class="codex-item"><b>${esc(c.name)}</b> <span class="muted sm">${esc(c.role || "")}</span><div class="sm">${esc(c.desc || "")}</div></div>`)) +
    sec("Locations", (b.setting?.locations || []).map((l) => `<div class="codex-item"><b>${esc(l.name)}</b><div class="sm">${esc(l.desc || "")}</div></div>`)) +
    sec("Items", (b.items || []).map((i) => `<div class="codex-item"><b>${esc(i.name)}</b> <span class="muted sm">${esc(i.effect || "")}</span><div class="sm">${esc(i.desc || "")}</div></div>`)) +
    sec("Factions", (b.factions || []).map((f) => `<div class="codex-item"><b>${esc(f.name)}</b><div class="sm">${esc(f.goal || "")}</div></div>`));
  $("#codexBody").innerHTML = body;
  $("#codex").classList.remove("hidden");
}

// ================= helpers =================
function locName(id) { const l = (bible.setting.locations || []).find((x) => x.id === id); return l ? l.name : id || "—"; }
function charName(id) { const c = (bible.characters || []).find((x) => x.id === id); return c ? c.name : id; }
function downloadJson(obj, name) { const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); }

async function loadSourceFile(file) {
  const name = (file.name || "").toLowerCase();
  try {
    if (name.endsWith(".pdf") || file.type === "application/pdf") { toast("Reading PDF…"); const text = await extractPdf(file, (m) => toast(m)); $("#novel").value = text; toast(`Loaded ${file.name} · ${text.length.toLocaleString()} chars`, "ok"); }
    else { $("#novel").value = await file.text(); toast("Loaded " + file.name, "ok"); }
  } catch (err) { toast("Could not read " + file.name + ": " + err.message, "err"); }
}
async function extractPdf(file, onProgress = () => {}) {
  const CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379";
  let pdfjs;
  try { pdfjs = await import(/* @vite-ignore */ CDN + "/pdf.min.mjs"); } catch (e) { throw new Error("PDF reader needs internet the first time. " + e.message); }
  pdfjs.GlobalWorkerOptions.workerSrc = CDN + "/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) { onProgress(`Extracting PDF page ${i}/${doc.numPages}…`); const pg = await doc.getPage(i); out += (await pg.getTextContent()).items.map((s) => s.str).join(" ") + "\n\n"; }
  return out.trim();
}

// ================= OFFLINE BAKED STORY =================
function play(storyId) { if (lib.stories[storyId] && lib.stories[storyId].baked) bakedPlay(storyId); else playStory(storyId); }
function bakedPlay(storyId) {
  activeStoryId = storyId;
  const s = lib.stories[storyId];
  bible = normalizeBible(s.bible);
  bakedTree = s.baked;
  const latest = Lib.latestRun(lib, storyId);
  if (latest && latest.run && latest.run.baked) { activeRunId = latest.id; run = latest.run; }
  else { run = E.newRunState(bible, String(Date.now()), settings.difficulty); run.baked = true; run.nodeId = bakedTree.rootId; activeRunId = Lib.createRun(lib, storyId, run, "Offline run 1"); }
  undoStack = [];
  openPlay();
}
function bakedNode() { return bakedTree && bakedTree.nodes[run.nodeId]; }
function bakedChoices(node) { return node.choices.map((c, i) => ({ id: "b" + i, text: c.text, stat: c.stat, skill: "", skillBonus: c.skillBonus, difficulty: c.difficulty, risk: c.risk, to: c.to })); }
function bakedShowCurrent() {
  const node = bakedNode();
  if (!node) return bakedEnding();
  if (!(run.log || []).length) { run.log.push({ role: "scene", text: node.scene }); appendLog("scene", esc(node.scene).replace(/\n/g, "<br>")); }
  if (node.end || !node.choices.length) return bakedEnding();
  currentTurn = { scene: node.scene, choices: bakedChoices(node) };
  renderChoices(); persist();
}
function bakedAdvance(c) {
  undoStack.push({ run: clone(run), turn: clone(currentTurn) });
  if (undoStack.length > 20) undoStack.shift();
  const rng = E.rngFor(run.seed, run.turn, E.hashStr(c.id));
  const result = E.check(rng, run.stats[c.stat] ?? 10, c.skillBonus, c.difficulty + E.diffOffset(run.difficulty));
  run.turn += 1;
  if (!run.journey) run.journey = { crits: 0, fumbles: 0, success: 0, fail: 0 };
  if (result.crit) run.journey.crits++;
  if (result.fumble) run.journey.fumbles++;
  run.journey[result.success ? "success" : "fail"]++;
  E.applyDelta(run, { xp: result.success ? 12 : 4, hp: result.success ? 0 : (result.fumble ? -6 : -2) });
  run.history.push({ turn: run.turn, choiceText: c.text, check: result });
  run.log.push({ role: "choice", text: c.text });
  E.pushRecap(run, `${c.text}\u2192${result.degree}`);
  appendLog("choice", `<b>${esc(c.text)}</b>`);
  appendLog("roll", `<span class="${result.success ? "ok" : "miss"}">d20 ${result.d20} +mods → ${result.total} vs DC ${result.difficulty} — <b>${result.degree.toUpperCase()}</b></span>`);
  run.nodeId = c.to;
  const node = bakedNode();
  if (node) { run.log.push({ role: "scene", text: node.scene }); appendLog("scene", esc(node.scene).replace(/\n/g, "<br>")); }
  renderHud();
  if (run.hp <= 0) return gameOver();
  if (!node || node.end || !node.choices.length) return bakedEnding();
  currentTurn = { scene: node.scene, choices: bakedChoices(node) };
  renderChoices(); persist();
}
function bakedEnding() {
  appendLog("scene", `<div class="gameover">An ending. ${run.turn} turns, ${run.xp} XP. Replay to find other paths.</div>`);
  $("#choices").innerHTML = `<button class="choice" id="restartBtn">Play this story again</button>`;
  $("#restartBtn").onclick = () => { run = E.newRunState(bible, String(Date.now()), settings.difficulty); run.baked = true; run.nodeId = bakedTree.rootId; activeRunId = Lib.createRun(lib, activeStoryId, run, "Offline run " + (Lib.runsForStory(lib, activeStoryId).length + 1)); undoStack = []; openPlay(); };
  persist();
}
function openBake(storyId) { bakeStoryId = storyId; $("#bakeProgress").classList.add("hidden"); $("#bakeBar").style.width = "0%"; $("#bakeStart").disabled = false; $("#bakeModal").classList.remove("hidden"); }
async function runBake() {
  const s = lib.stories[bakeStoryId]; if (!s) return;
  const b = normalizeBible(s.bible);
  const need = PROVIDERS[settings.provider].needsKey;
  const haveKey = settings.apiKey || (settings.pool && settings.pool.some((e) => e.apiKey));
  if (need && !haveKey) return toast("Set an API key in Settings first (or pick Offline Demo).", "err");
  $("#bakeStart").disabled = true; $("#bakeProgress").classList.remove("hidden");
  const size = Number($("#bakeSize").value) || 60;
  try {
    const baked = await bakeStory(settings, b, { maxNodes: size }, (m, pct) => { $("#bakeLog").textContent = m; if (pct != null) $("#bakeBar").style.width = pct + "%"; });
    Lib.updateStory(lib, bakeStoryId, { baked });
    $("#bakeModal").classList.add("hidden"); renderLibrary();
    toast(`Baked ${baked.count} nodes · ${baked.tokens.toLocaleString()} tokens — offline ready.`, "ok");
  } catch (e) { toast("Bake failed: " + e.message, "err"); $("#bakeLog").textContent = e.message; $("#bakeStart").disabled = false; }
}
async function forceUpdate() {
  try { if ("serviceWorker" in navigator) { const regs = await navigator.serviceWorker.getRegistrations(); for (const r of regs) await r.unregister(); } if (window.caches) { const ks = await caches.keys(); for (const k of ks) await caches.delete(k); } } catch {}
  location.reload();
}

// ================= settings & theme =================
function applyTheme(t) { document.documentElement.dataset.theme = t && t !== "auto" ? t : ""; }
function provNote(noteSel, keyRowSel, key) { const p = PROVIDERS[key]; $(noteSel).innerHTML = p.note + (p.keyUrl ? ` — <a href="${p.keyUrl}" target="_blank" rel="noopener">get a key</a>` : ""); $(keyRowSel).style.display = p.needsKey ? "" : "none"; }
function openSettings() {
  const sp = $("#s_provider"); sp.innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join(""); sp.value = settings.provider;
  const sl = $("#s_length"); sl.innerHTML = Object.entries(LENGTHS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join(""); sl.value = settings.length || "normal";
  $("#s_base").value = settings.base; $("#s_model").value = settings.model; $("#s_apiKey").value = settings.apiKey || ""; $("#s_keyPool").value = settings.poolText || "";
  $("#s_diff").value = settings.difficulty || "normal"; $("#s_depth").value = settings.contextDepth || "full"; $("#s_theme").value = settings.theme || "auto"; $("#s_eco").checked = !!settings.economy;
  provNote("#s_note", "#s_keyRow", settings.provider);
  sp.onchange = () => { const p = PROVIDERS[sp.value]; if (sp.value !== "custom") { $("#s_base").value = p.base; $("#s_model").value = p.model; } provNote("#s_note", "#s_keyRow", sp.value); };
  $("#settingsModal").classList.remove("hidden");
}
function saveSettings() {
  settings.provider = $("#s_provider").value; settings.base = $("#s_base").value.trim(); settings.model = $("#s_model").value.trim();
  settings.apiKey = $("#s_apiKey").value.trim(); settings.length = $("#s_length").value; settings.difficulty = $("#s_diff").value;
  settings.contextDepth = $("#s_depth").value; settings.theme = $("#s_theme").value; settings.economy = $("#s_eco").checked;
  settings.poolText = $("#s_keyPool").value || ""; settings.pool = parsePool(settings.poolText, settings);
  settings.maxTokens = settings.economy ? LENGTHS.lean.tokens : (LENGTHS[settings.length] || LENGTHS.normal).tokens;
  store.set(SETTINGS_KEY, settings); applyTheme(settings.theme); renderProviders();
  $("#settingsModal").classList.add("hidden"); toast("Settings saved.", "ok");
}

// ================= wire up =================
function goLibrary() { persist(); renderLibrary(); show("library"); }

function init() {
  renderProviders();
  // library
  $("#newStoryBtn").onclick = $("#newStoryBtn2").onclick = () => { $("#novel").value = ""; show("setup"); };
  $("#libSearch").oninput = renderLibrary;
  $("#importStoryFile").onchange = (e) => e.target.files[0] && importStory(e.target.files[0]);
  $("#storyGrid").onclick = (e) => { const btn = e.target.closest("[data-act]"); const card = e.target.closest("[data-story]"); if (btn && card) handleLibAction(btn.dataset.act, card.dataset.story); else if (card) play(card.dataset.story); };
  $("#bakeStart").onclick = runBake;
  $("#bakeClose").onclick = () => $("#bakeModal").classList.add("hidden");
  $("#installBtn").onclick = async () => { if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $("#installBtn").classList.add("hidden"); } };
  $("#forceUpdate").onclick = forceUpdate;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; $("#installBtn").classList.remove("hidden"); });
  // setup
  $("#setupBack").onclick = goLibrary;
  $("#scanBtn").onclick = doScan;
  $("#novelFile").onchange = async (e) => { const f = e.target.files[0]; if (f) await loadSourceFile(f); e.target.value = ""; };
  $("#sampleBtn").onclick = async () => { try { const r = await fetch("assets/sample-novel.txt"); $("#novel").value = await r.text(); toast("Sample loaded.", "ok"); } catch { toast("Sample not found.", "err"); } };
  // audit
  $("#backSetup").onclick = () => show("setup");
  $("#rescanBtn").onclick = () => show("setup");
  $("#forgeBtn").onclick = forgeFromAudit;
  // play
  $("#menuBtn").onclick = goLibrary;
  $("#rewindBtn").onclick = rewind;
  $("#codexBtn").onclick = openCodex;
  $("#codexClose").onclick = () => $("#codex").classList.add("hidden");
  $("#statsToggle").onclick = () => $("#sidebar").classList.toggle("open");
  $("#exportBtn").onclick = () => downloadJson({ type: "storyforge-save", bible, run }, (bible.title || "save").replace(/\W+/g, "_") + "_save.json");
  $("#saveAsBtn").onclick = () => { const n = prompt("Name this save slot:", "Save " + (Lib.runsForStory(lib, activeStoryId).length + 1)); if (n) { activeRunId = Lib.createRun(lib, activeStoryId, clone(run), n.trim()); toast("Saved to new slot.", "ok"); } };
  $("#newRunBtn").onclick = () => { if (confirm("Start a fresh run of this story?")) { run = E.newRunState(bible, String(Date.now()), settings.difficulty); activeRunId = Lib.createRun(lib, activeStoryId, run, "Save " + (Lib.runsForStory(lib, activeStoryId).length + 1)); undoStack = []; openPlay(); } };
  $("#pointsBlock").onclick = (e) => { const b = e.target.closest("[data-stat]"); if (b && (run.statPoints || 0) > 0) { run.stats[b.dataset.stat] = (run.stats[b.dataset.stat] || 10) + 1; run.statPoints--; persist(); renderHud(); } };
  $("#settingsBtn").onclick = openSettings;
  $("#settingsClose").onclick = () => $("#settingsModal").classList.add("hidden");
  $("#settingsSave").onclick = saveSettings;
  $("#freeForm").onsubmit = (e) => { e.preventDefault(); const v = $("#freeInput").value; $("#freeInput").value = ""; freeAction(v); };
  // runs modal
  $("#runsClose").onclick = () => $("#runsModal").classList.add("hidden");
  $("#runsNew").onclick = () => { bible = normalizeBible(lib.stories[activeStoryId].bible); run = E.newRunState(bible, String(Date.now()), settings.difficulty); activeRunId = Lib.createRun(lib, activeStoryId, run, "Save " + (Lib.runsForStory(lib, activeStoryId).length + 1)); $("#runsModal").classList.add("hidden"); undoStack = []; openPlay(); };
  $("#runsList").onclick = (e) => { const btn = e.target.closest("[data-ract]"); const row = e.target.closest("[data-run]"); if (btn && row) handleRunAction(btn.dataset.ract, row.dataset.run); };

  applyTheme(settings.theme);
  Lib.migrateLegacy(lib);
  renderLibrary();
  show("library");
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then((reg) => reg.update()).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded) { reloaded = true; location.reload(); } });
  }
}
document.addEventListener("DOMContentLoaded", init);
