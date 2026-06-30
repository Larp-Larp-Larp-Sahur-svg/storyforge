// library.js — the Story Library: persistent shelf of stories + save slots (runs).
// Everything lives in localStorage so your worlds survive reloads, fully offline.

const LS = "sf.lib.v1";

export function uid(prefix = "id") {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function loadLib() {
  try {
    const lib = JSON.parse(localStorage.getItem(LS));
    if (lib && lib.stories && lib.runs) return lib;
  } catch {}
  return { stories: {}, runs: {} };
}
export function saveLib(lib) {
  localStorage.setItem(LS, JSON.stringify(lib));
}

// Stories ---------------------------------------------------------------------
export function createStory(lib, bible) {
  const id = uid("story");
  const now = Date.now();
  lib.stories[id] = {
    id, bible,
    title: bible.title || "Untitled",
    logline: bible.logline || "",
    tags: [...(bible.genres || []), ...(bible.tone || [])].slice(0, 5),
    cover: coverFor(bible.title),
    createdAt: now, updatedAt: now,
  };
  saveLib(lib);
  return id;
}
export function updateStory(lib, id, patch) {
  if (!lib.stories[id]) return;
  Object.assign(lib.stories[id], patch, { updatedAt: Date.now() });
  saveLib(lib);
}
export function deleteStory(lib, id) {
  delete lib.stories[id];
  for (const rid of Object.keys(lib.runs)) if (lib.runs[rid].storyId === id) delete lib.runs[rid];
  saveLib(lib);
}
export function duplicateStory(lib, id) {
  const s = lib.stories[id];
  if (!s) return null;
  const nid = uid("story");
  const now = Date.now();
  lib.stories[nid] = { ...JSON.parse(JSON.stringify(s)), id: nid, title: s.title + " (copy)", createdAt: now, updatedAt: now };
  saveLib(lib);
  return nid;
}
export function listStories(lib) {
  return Object.values(lib.stories).sort((a, b) => b.updatedAt - a.updatedAt);
}

// Runs (save slots) -----------------------------------------------------------
export function createRun(lib, storyId, run, name) {
  const id = uid("run");
  const n = runsForStory(lib, storyId).length + 1;
  lib.runs[id] = { id, storyId, name: name || `Save ${n}`, run, updatedAt: Date.now() };
  saveLib(lib);
  return id;
}
export function saveRun(lib, id, run) {
  if (!lib.runs[id]) return;
  lib.runs[id].run = run;
  lib.runs[id].updatedAt = Date.now();
  if (lib.stories[lib.runs[id].storyId]) lib.stories[lib.runs[id].storyId].updatedAt = Date.now();
  saveLib(lib);
}
export function renameRun(lib, id, name) { if (lib.runs[id]) { lib.runs[id].name = name; saveLib(lib); } }
export function deleteRun(lib, id) { delete lib.runs[id]; saveLib(lib); }
export function runsForStory(lib, storyId) {
  return Object.values(lib.runs).filter((r) => r.storyId === storyId).sort((a, b) => b.updatedAt - a.updatedAt);
}
export function latestRun(lib, storyId) { return runsForStory(lib, storyId)[0] || null; }

// Helpers ---------------------------------------------------------------------
function coverFor(title) {
  const letters = (title || "S").replace(/[^A-Za-z]/g, "");
  return (letters[0] || "S").toUpperCase();
}

// Migrate the old single-story format (sf.bible + sf.run) into the library once.
export function migrateLegacy(lib) {
  try {
    const oldBible = JSON.parse(localStorage.getItem("sf.bible"));
    const oldRun = JSON.parse(localStorage.getItem("sf.run"));
    if (oldBible && !Object.keys(lib.stories).length) {
      const sid = createStory(lib, oldBible);
      if (oldRun && (oldRun.log || []).length) createRun(lib, sid, oldRun, "Continued save");
      localStorage.removeItem("sf.bible");
      localStorage.removeItem("sf.run");
      return true;
    }
  } catch {}
  return false;
}
