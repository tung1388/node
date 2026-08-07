import { encryptBuffer, decryptBuffer, splitIntoChunks, CHUNK_SIZE } from "./crypto.js";
import { getFile, putFile, getPublicFile } from "./github.js";
import { isSqliteFile, renderSqlitePreview } from "./sqlitePreview.js";

const CHUNK_UPLOAD_CONCURRENCY = 4;

// Runs `worker` over `items` with at most `limit` in flight at once -
// mirrors src/githubStore.js's runWithConcurrency.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// TODO: fill in once you've created the dedicated repo for this app+media
const OWNER = "tung1388";
const REPO = "node";

// This is a single-folder instance - always the same folder, so the
// login form only ever asks for the password (the encryption key).
const FOLDER = "node";

const STORAGE_KEY = "githost.session";

const el = (id) => document.getElementById(id);

const els = {
  loginScreen: el("login-screen"),
  loginForm: el("login-form"),
  loginPassword: el("login-password"),
  loginStatus: el("login-status"),
  loginError: el("login-error"),
  app: el("app"),
  logoutBtn: el("logout-btn"),
  fileInput: el("file-input"),
  uploadStatus: el("upload-status"),
  fileList: el("file-list"),
  otherFilesHeader: el("other-files-header"),
  otherFilesArrow: el("other-files-arrow"),
  otherFilesBody: el("other-files-body"),
  previewModal: el("preview-modal"),
  previewTitle: el("preview-title"),
  previewBody: el("preview-body"),
  previewClose: el("preview-close"),
};

// =====================================================================
// Session / manifest (unchanged storage model - see system.md)
// =====================================================================

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}
function saveSession(session) { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); }
function clearSession() { localStorage.removeItem(STORAGE_KEY); }

function manifestPath(session) { return `blobs/${session.folder}/manifest.enc`; }
function blobPath(session, id) { return `blobs/${session.folder}/${id}.enc`; }
function chunkPath(session, id, index) { return `blobs/${session.folder}/${id}/${index}.enc`; }

async function loadManifest(session) {
  const existing = await getFile({ ...session, path: manifestPath(session) });
  if (!existing) return { entries: [], sha: null };
  const decrypted = await decryptBuffer(existing.bytes, session.key);
  const entries = JSON.parse(new TextDecoder().decode(decrypted));
  return { entries, sha: existing.sha };
}

async function saveManifest(session, entries, sha) {
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  const encrypted = await encryptBuffer(bytes, session.key);
  await putFile({
    ...session,
    path: manifestPath(session),
    bytes: encrypted,
    message: `update manifest (${entries.length} files)`,
    sha,
  });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

let currentSession = null;
let currentEntries = [];
let currentManifestSha = null;

// =====================================================================
// Media browsing model
// ---------------------------------------------------------------------
// The local `node/webapp` (Image Sorter) browses a real filesystem: an
// Input root of shoot folders, an Output root that mirrors Input's
// folder names 1:1 (populated by compress.js/createJobs.js), plus flat
// Videos/Archive buckets. This static app has no filesystem - instead
// it treats each manifest entry's `name` as a path ("input/<folder>/
// <subpath>", "output/<folder>/<subpath>", etc. - a convention written
// by src/cli.js's `upload-folder <folder> <dir> <root>`), and derives
// everything the local app got from live directory scans by filtering
// the already-decrypted, in-memory manifest instead.
//
// Matching logic (imageDirName/promptHash/prefix matching) is a direct
// port of lib.js/server.js's algorithm so "Find Outputs" keeps working
// against files createJobs.js actually produced.
// =====================================================================

const ROOTS = ["input", "output", "videos", "archive"];

function entryRoot(entry) {
  const slash = entry.name.indexOf("/");
  return slash === -1 ? "" : entry.name.slice(0, slash);
}

function relPathWithinRoot(entry, root) {
  return entry.name.slice(root.length + 1);
}

function isImageEntry(entry) { return (entry.type || "").startsWith("image/"); }
function isVideoEntry(entry) { return (entry.type || "").startsWith("video/"); }
function isAudioEntry(entry) { return (entry.type || "").startsWith("audio/"); }
function isTextEntry(entry) { return (entry.type || "").startsWith("text/"); }
function isMediaEntry(entry) { return isImageEntry(entry) || isVideoEntry(entry); }
function isArchiveTypeEntry(entry) { return isAudioEntry(entry) || isTextEntry(entry); }

// Mirrors lib.js's sanitizeFilename()/imageDirName() - the naming scheme
// createJobs.js used to build each output filename's prefix, so "Find
// Outputs" can find the outputs for one specific input image.
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}
function imageDirName(relPath) {
  const parts = relPath.split("/");
  const last = parts[parts.length - 1];
  const stem = sanitizeFilename(last.replace(/\.[^./]+$/, ""));
  if (parts.length === 1) return stem;
  const dirPart = parts.slice(0, -1).map(sanitizeFilename).join("__");
  return `${dirPart}__${stem}`;
}

// Mirrors lib.js's promptHash() (Node crypto -> Web Crypto).
async function promptHash(text) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}
async function parsePrompts(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return Promise.all(lines.map(async (line, index) => ({ index, text: line, hash: await promptHash(line) })));
}
function matchPromptIndex(name, allPrompts) {
  const lower = name.toLowerCase();
  const found = allPrompts.find((p) => lower.includes(`_${p.hash}__`) || lower.includes(`__${p.hash}__`));
  return found ? found.index : -1;
}

function naturalSort(list) {
  return [...list].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function baseNameOf(subPath) {
  const slash = subPath.lastIndexOf("/");
  const base = slash === -1 ? subPath : subPath.slice(slash + 1);
  return base.replace(/\.[^./]+$/, "");
}

/**
 * Filters currentEntries down to media under `root` (and, if given, under
 * `root/folder/`), applying the same prompt-hash filter and video-
 * thumbnail-pairing the local webapp's scanFolder()/server.js did.
 * `folder === ""` means "the whole root, no folder segmentation" - used
 * for the Videos/Archive flat buckets, and for Find Outputs' nested-path
 * folder keys (which can themselves be multi-segment).
 */
function scanEntries({ root, folder, promptFilter }) {
  const prefix = `${root}/`;
  const allowed = root === "archive" ? isArchiveTypeEntry : isMediaEntry;
  const folderPrefix = folder ? `${folder}/` : "";

  const results = [];
  for (const entry of currentEntries) {
    if (!entry.name.startsWith(prefix)) continue;
    if (!allowed(entry)) continue;
    const relPath = relPathWithinRoot(entry, root);
    let subPath;
    if (folder === "") {
      subPath = relPath;
    } else {
      if (!relPath.startsWith(folderPrefix)) continue;
      subPath = relPath.slice(folderPrefix.length);
    }

    const lower = entry.name.toLowerCase();
    let promptIndex = -1;
    if (promptFilter && promptFilter.length > 0) {
      const found = promptFilter.find((p) => lower.includes(`_${p.hash}__`) || lower.includes(`__${p.hash}__`));
      if (!found) continue;
      promptIndex = found.index;
    }

    results.push({
      id: entry.id, name: subPath, folder, promptIndex, size: entry.size, type: entry.type,
      isVideo: isVideoEntry(entry), isAudio: isAudioEntry(entry), isText: isTextEntry(entry),
      thumbnailId: null,
    });
  }

  if (root === "videos") {
    const byDir = new Map();
    for (const r of results) {
      const slash = r.name.lastIndexOf("/");
      const dir = slash === -1 ? "" : r.name.slice(0, slash);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(r);
    }
    const toRemove = new Set();
    for (const group of byDir.values()) {
      const videoBases = new Set(group.filter((r) => r.isVideo).map((r) => baseNameOf(r.name).toLowerCase()));
      for (const r of group) {
        if (!r.isVideo && videoBases.has(baseNameOf(r.name).toLowerCase())) toRemove.add(r.id);
      }
      for (const r of group) {
        if (!r.isVideo) continue;
        const thumb = group.find((x) => !x.isVideo && baseNameOf(x.name).toLowerCase() === baseNameOf(r.name).toLowerCase());
        if (thumb) r.thumbnailId = thumb.id;
      }
    }
    return results.filter((r) => !toRemove.has(r.id));
  }

  return results;
}

function sortResults(results, sortMode) {
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const sorted = [...results];
  if (sortMode === "folder") sorted.sort((a, b) => cmp(a.folder, b.folder) || cmp(a.name, b.name));
  else if (sortMode === "prompt") sorted.sort((a, b) => a.promptIndex - b.promptIndex || cmp(a.name, b.name));
  else sorted.sort((a, b) => cmp(a.name, b.name));
  return sorted;
}

function listInputFolders() {
  const folders = new Set();
  const prefix = "input/";
  for (const entry of currentEntries) {
    if (!entry.name.startsWith(prefix)) continue;
    const rest = entry.name.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash !== -1) folders.add(rest.slice(0, slash));
  }
  return naturalSort([...folders]);
}

// =====================================================================
// Object URLs (decrypted bytes -> blob: URL), lazily loaded and cached
// =====================================================================

const objectUrlCache = new Map(); // id -> resolved url
const objectUrlPending = new Map(); // id -> in-flight promise

async function fetchEntryBytes(entry) {
  if (entry.chunked) {
    const chunks = await Promise.all(
      Array.from({ length: entry.chunkCount }, async (_, index) => {
        const stored = await getFile({ ...currentSession, path: chunkPath(currentSession, entry.id, index) });
        if (!stored) throw new Error(`${entry.name} is missing chunk ${index} (was it deleted outside this app?).`);
        return decryptBuffer(stored.bytes, currentSession.key);
      })
    );
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }
  const stored = await getFile({ ...currentSession, path: blobPath(currentSession, entry.id) });
  if (!stored) throw new Error(`${entry.name} is missing from the repo (was it deleted outside this app?).`);
  return decryptBuffer(stored.bytes, currentSession.key);
}

function findEntryById(id) { return currentEntries.find((e) => e.id === id); }

async function objectUrlFor(id) {
  if (objectUrlCache.has(id)) return objectUrlCache.get(id);
  if (objectUrlPending.has(id)) return objectUrlPending.get(id);
  const entry = findEntryById(id);
  if (!entry) throw new Error("Unknown file");
  const promise = (async () => {
    const bytes = await fetchEntryBytes(entry);
    const url = URL.createObjectURL(new Blob([bytes], { type: entry.type }));
    objectUrlCache.set(id, url);
    objectUrlPending.delete(id);
    return url;
  })();
  objectUrlPending.set(id, promise);
  return promise;
}

function revokeAllObjectUrls() {
  for (const url of objectUrlCache.values()) URL.revokeObjectURL(url);
  objectUrlCache.clear();
  objectUrlPending.clear();
}

// Fills `imgOrVideoEl.src` once its bytes decrypt, lazily (only once the
// element scrolls near the viewport) so a big library doesn't decrypt
// every thumbnail at once.
const lazyObserver = new IntersectionObserver((observedEntries) => {
  for (const oe of observedEntries) {
    if (!oe.isIntersecting) continue;
    lazyObserver.unobserve(oe.target);
    const mediaEl = oe.target;
    const id = mediaEl.dataset.lazyId;
    objectUrlFor(id).then((url) => { mediaEl.src = url; })
      .catch(() => { mediaEl.replaceWith(makeIconEl("⚠️")); });
  }
}, { rootMargin: "200px" });

function observeLazy(mediaEl, id) {
  mediaEl.dataset.lazyId = id;
  lazyObserver.observe(mediaEl);
}

function makeIconEl(text) {
  const div = document.createElement("div");
  div.className = "thumb-file-icon";
  div.textContent = text;
  return div;
}

// =====================================================================
// Browsing state (mirrors node/webapp/public/app.js's `state`)
// =====================================================================

const state = {
  inputFolders: [],
  selectedFolders: new Set(),
  lastClickedFolderIndex: null,
  searchAllFolders: false,
  showVideos: false,
  showArchive: false,
  prompts: [],
  selectedPromptIndices: new Set(),
  includeNonMatching: false,
  sortMode: "name",
  searchText: "",
  matches: [],
  gridMode: "input", // 'input' | 'videos' | 'archive' | 'outputs'
  selectedIds: new Set(),
  lastClickedIndex: null,
  collapsedFolderGroups: new Set(),
  inputSectionOpen: true,
  videosSectionOpen: true,
  archiveSectionOpen: true,
};

const statusEl = el("status");
function setStatus(text) { statusEl.textContent = text; }

async function findPromptsEntry() {
  return currentEntries.find((e) => /(^|\/)prompts\.txt$/i.test(e.name));
}

async function loadPrompts() {
  const promptsEntry = await findPromptsEntry();
  if (!promptsEntry) { state.prompts = []; renderPromptList(); return; }
  try {
    const bytes = await fetchEntryBytes(promptsEntry);
    state.prompts = await parsePrompts(new TextDecoder().decode(bytes));
  } catch {
    state.prompts = []; // missing/corrupt prompts.txt shouldn't break browsing everything else
  }
  renderPromptList();
}

// ---------- Left panel: Input folder list ----------

function buildListItemRow(label, isSelected) {
  const div = document.createElement("div");
  div.className = "list-item" + (isSelected ? " selected" : "");
  const check = document.createElement("span");
  check.className = "list-item-check";
  check.textContent = isSelected ? "✓" : "";
  div.appendChild(check);
  const text = document.createElement("span");
  text.className = "list-item-text";
  text.textContent = label;
  div.appendChild(text);
  return div;
}

function renderFolderList() {
  const container = el("input-folder-list");
  container.innerHTML = "";

  const allRow = buildListItemRow("All folders", state.searchAllFolders);
  allRow.classList.add("list-item-pinned");
  allRow.addEventListener("click", () => toggleAllFolders());
  container.appendChild(allRow);

  state.inputFolders.forEach((name, i) => {
    const isSelected = state.searchAllFolders || state.selectedFolders.has(name);
    const div = buildListItemRow(`${i + 1}: ${name}`, isSelected);
    div.addEventListener("click", (ev) => onFolderClick(ev, i));
    container.appendChild(div);
  });
}

function toggleAllFolders() {
  state.searchAllFolders = !state.searchAllFolders;
  exitVideosMode();
  exitArchiveMode();
  renderFolderList();
  refreshMatches();
}

function onFolderClick(ev, index) {
  const name = state.inputFolders[index];
  const set = state.selectedFolders;
  if (ev.shiftKey && state.lastClickedFolderIndex !== null) {
    const [a, b] = [state.lastClickedFolderIndex, index].sort((x, y) => x - y);
    for (let i = a; i <= b; i += 1) set.add(state.inputFolders[i]);
  } else if (set.has(name)) {
    set.delete(name);
  } else {
    set.add(name);
  }
  state.lastClickedFolderIndex = index;
  exitVideosMode();
  exitArchiveMode();
  renderFolderList();
  refreshMatches();
}

// ---------- Videos / Archive (flat buckets) ----------

function renderVideosSection() {
  const container = el("videos-list");
  container.innerHTML = "";
  const row = buildListItemRow("All videos", state.showVideos);
  row.addEventListener("click", () => toggleVideos());
  container.appendChild(row);
}
function renderArchiveSection() {
  const container = el("archive-list");
  container.innerHTML = "";
  const row = buildListItemRow("All archive", state.showArchive);
  row.addEventListener("click", () => toggleArchive());
  container.appendChild(row);
}
function exitVideosMode() {
  if (!state.showVideos) return;
  state.showVideos = false;
  renderVideosSection();
}
function exitArchiveMode() {
  if (!state.showArchive) return;
  state.showArchive = false;
  renderArchiveSection();
}
function toggleVideos() {
  state.showVideos = !state.showVideos;
  if (state.showVideos) {
    state.searchAllFolders = false;
    state.selectedFolders.clear();
    renderFolderList();
    exitArchiveMode();
  }
  renderVideosSection();
  refreshVideos();
}
function toggleArchive() {
  state.showArchive = !state.showArchive;
  if (state.showArchive) {
    state.searchAllFolders = false;
    state.selectedFolders.clear();
    renderFolderList();
    exitVideosMode();
  }
  renderArchiveSection();
  refreshArchive();
}

function applySectionCollapse() {
  el("input-section").classList.toggle("collapsed", !state.inputSectionOpen);
  el("input-folder-list").classList.toggle("collapsed", !state.inputSectionOpen);
  el("input-section-arrow").classList.toggle("collapsed", !state.inputSectionOpen);
  el("videos-section").classList.toggle("collapsed", !state.videosSectionOpen);
  el("videos-list").classList.toggle("collapsed", !state.videosSectionOpen);
  el("videos-section-arrow").classList.toggle("collapsed", !state.videosSectionOpen);
  el("archive-section").classList.toggle("collapsed", !state.archiveSectionOpen);
  el("archive-list").classList.toggle("collapsed", !state.archiveSectionOpen);
  el("archive-section-arrow").classList.toggle("collapsed", !state.archiveSectionOpen);
}
el("input-section-header").addEventListener("click", () => { state.inputSectionOpen = !state.inputSectionOpen; applySectionCollapse(); });
el("videos-section-header").addEventListener("click", () => { state.videosSectionOpen = !state.videosSectionOpen; applySectionCollapse(); });
el("archive-section-header").addEventListener("click", () => { state.archiveSectionOpen = !state.archiveSectionOpen; applySectionCollapse(); });

// ---------- Right panel resizer ----------

const RIGHT_PANEL_MIN = 160;
const RIGHT_PANEL_MAX = 700;
(function initRightResizer() {
  const resizer = el("right-resizer");
  const panel = el("right-panel");
  let dragging = false;
  resizer.addEventListener("pointerdown", (ev) => {
    dragging = true;
    resizer.classList.add("dragging");
    resizer.setPointerCapture(ev.pointerId);
  });
  resizer.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const width = Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, window.innerWidth - ev.clientX));
    panel.style.flexBasis = width + "px";
  });
  function endDrag(ev) {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    try { resizer.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
  }
  resizer.addEventListener("pointerup", endDrag);
  resizer.addEventListener("pointercancel", endDrag);
})();

// ---------- Right panel: Prompts ----------

function renderPromptList() {
  const container = el("prompt-list");
  container.innerHTML = "";

  const nonMatchingRow = buildListItemRow("Non-matching (no prompt match)", state.includeNonMatching);
  nonMatchingRow.classList.add("list-item-pinned");
  nonMatchingRow.addEventListener("click", () => {
    state.includeNonMatching = !state.includeNonMatching;
    renderPromptList();
  });
  container.appendChild(nonMatchingRow);

  state.prompts.forEach((p) => {
    const isSelected = state.selectedPromptIndices.has(p.index);
    const div = buildListItemRow(`${p.index}: ${p.text}`, isSelected);
    div.title = p.text;
    div.addEventListener("click", () => {
      if (state.selectedPromptIndices.has(p.index)) state.selectedPromptIndices.delete(p.index);
      else state.selectedPromptIndices.add(p.index);
      renderPromptList();
    });
    container.appendChild(div);
  });
}
el("btn-prompts-all").addEventListener("click", () => {
  state.prompts.forEach((p) => state.selectedPromptIndices.add(p.index));
  state.includeNonMatching = true;
  renderPromptList();
});
el("btn-prompts-none").addEventListener("click", () => {
  state.selectedPromptIndices.clear();
  state.includeNonMatching = false;
  renderPromptList();
});

// ---------- Matches / grid ----------

async function refreshMatches() {
  if (!state.searchAllFolders && state.selectedFolders.size === 0) {
    state.matches = [];
    renderGrid();
    setStatus('Pick one or more Input folders to see their images, or select "All folders" at the top of the list.');
    return;
  }
  const folders = state.searchAllFolders ? listInputFolders() : [...state.selectedFolders];
  let results = [];
  for (const f of folders) results.push(...scanEntries({ root: "input", folder: f, promptFilter: null }));
  if (state.searchText) results = results.filter((m) => m.name.toLowerCase().includes(state.searchText.toLowerCase()));
  results = sortResults(results, state.sortMode);

  state.matches = results;
  state.gridMode = "input";
  state.selectedIds = new Set([...state.selectedIds].filter((id) => results.some((m) => m.id === id)));
  renderGrid();
  setStatus(`${results.length} input image(s) found.`);
}

async function refreshVideos() {
  if (!state.showVideos) {
    state.matches = [];
    renderGrid();
    setStatus('Select "All videos" to browse the videos folder.');
    return;
  }
  const results = sortResults(scanEntries({ root: "videos", folder: "", promptFilter: null }), state.sortMode);
  state.matches = results;
  state.gridMode = "videos";
  state.selectedIds = new Set([...state.selectedIds].filter((id) => results.some((m) => m.id === id)));
  renderGrid();
  setStatus(`${results.length} video(s) found.`);
}

async function refreshArchive() {
  if (!state.showArchive) {
    state.matches = [];
    renderGrid();
    setStatus('Select "All archive" to browse the archive folder.');
    return;
  }
  const results = sortResults(scanEntries({ root: "archive", folder: "", promptFilter: null }), state.sortMode);
  state.matches = results;
  state.gridMode = "archive";
  state.selectedIds = new Set([...state.selectedIds].filter((id) => results.some((m) => m.id === id)));
  renderGrid();
  setStatus(`${results.length} archive item(s) found.`);
}

function matchDisplayPath(m) {
  return m.folder ? `${m.folder}/${m.name}` : m.name;
}

function buildThumbCell(m, index) {
  const cell = document.createElement("div");
  cell.className = "thumb" + (state.selectedIds.has(m.id) ? " selected" : "");
  cell.dataset.id = m.id;

  if (m.isVideo) {
    if (m.thumbnailId) {
      const img = document.createElement("img");
      img.alt = m.name;
      observeLazy(img, m.thumbnailId);
      cell.appendChild(img);
    } else {
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "none";
      video.playsInline = true;
      observeLazy(video, m.id);
      cell.appendChild(video);
    }
    const playBadge = document.createElement("div");
    playBadge.className = "thumb-video-badge";
    playBadge.textContent = "▶";
    cell.appendChild(playBadge);
  } else if (m.isAudio || m.isText) {
    cell.appendChild(makeIconEl(m.isAudio ? "\u{1F3B5}" : "\u{1F4C4}"));
  } else {
    const img = document.createElement("img");
    img.alt = m.name;
    observeLazy(img, m.id);
    cell.appendChild(img);
  }

  const check = document.createElement("div");
  check.className = "thumb-check";
  check.textContent = "✓";
  cell.appendChild(check);

  const label = document.createElement("div");
  label.className = "thumb-label" + (m.orphanReason ? " thumb-label-orphan" : "");
  const prefix = m.orphanReason ? `[orphan: ${m.orphanReason}] ` : m.promptIndex >= 0 ? `[${m.promptIndex}] ` : "";
  label.textContent = prefix + matchDisplayPath(m);
  cell.appendChild(label);

  cell.addEventListener("click", (ev) => onThumbClick(ev, index));
  cell.addEventListener("dblclick", () => openPreview(index));
  return cell;
}

function groupMatchesByFolder() {
  const groups = new Map();
  state.matches.forEach((m, index) => {
    const slash = m.name.lastIndexOf("/");
    const subDir = slash === -1 ? "" : m.name.slice(0, slash);
    const key = subDir ? `${m.folder}/${subDir}` : m.folder;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ m, index });
  });
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" })));
}

function renderGrid() {
  const grid = el("grid");
  grid.innerHTML = "";
  if (state.matches.length === 0) {
    grid.innerHTML = '<p class="hint">No items to show.</p>';
    return;
  }

  const groups = groupMatchesByFolder();
  const showHeaders = groups.size > 1;

  for (const [groupKey, entries] of groups) {
    const isCollapsed = showHeaders && state.collapsedFolderGroups.has(groupKey);
    if (showHeaders) {
      const header = document.createElement("div");
      header.className = "folder-group-header";
      const arrow = document.createElement("span");
      arrow.className = "folder-group-arrow" + (isCollapsed ? " collapsed" : "");
      arrow.textContent = "▾";
      header.appendChild(arrow);
      const title = document.createElement("span");
      title.textContent = `${groupKey || "(root)"} (${entries.length})`;
      header.appendChild(title);
      header.addEventListener("click", () => {
        if (state.collapsedFolderGroups.has(groupKey)) state.collapsedFolderGroups.delete(groupKey);
        else state.collapsedFolderGroups.add(groupKey);
        renderGrid();
      });
      grid.appendChild(header);
    }
    const subgrid = document.createElement("div");
    subgrid.className = "thumb-grid" + (isCollapsed ? " collapsed" : "");
    entries.forEach(({ m, index }) => subgrid.appendChild(buildThumbCell(m, index)));
    grid.appendChild(subgrid);
  }
}

function updateSelectionClasses() {
  for (const cell of el("grid").querySelectorAll(".thumb")) {
    cell.classList.toggle("selected", state.selectedIds.has(cell.dataset.id));
  }
}

function onThumbClick(ev, index) {
  const m = state.matches[index];
  if (ev.shiftKey && state.lastClickedIndex !== null) {
    const [a, b] = [state.lastClickedIndex, index].sort((x, y) => x - y);
    for (let i = a; i <= b; i += 1) state.selectedIds.add(state.matches[i].id);
  } else if (state.selectedIds.has(m.id)) {
    state.selectedIds.delete(m.id);
  } else {
    state.selectedIds.add(m.id);
  }
  state.lastClickedIndex = index;
  updateSelectionClasses();
}

// ---------- Full-viewport media viewer ----------

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 12;
const ZOOM_STEP = 1.15;
const FILMSTRIP_WINDOW = 12;

const preview = {
  items: [], index: 0, kind: "image", zoom: 1, panX: 0, panY: 0,
  dragging: false, dragMoved: false, dragStartX: 0, dragStartY: 0, dragOrigPanX: 0, dragOrigPanY: 0,
};

function isViewerOpen() { return !el("viewer-overlay").classList.contains("hidden"); }

function openPreview(index) {
  preview.items = state.matches;
  preview.index = index;
  preview.zoom = 1;
  preview.panX = 0;
  preview.panY = 0;
  el("viewer-overlay").classList.remove("hidden");
  showPreviewImage();
  renderFilmstrip();
}
function closeViewer() {
  el("viewer-overlay").classList.add("hidden");
  el("viewer-video").pause();
  el("viewer-audio").pause();
}
function applyTransform() {
  if (preview.kind !== "image") return;
  el("viewer-image").style.transform = `translate(${preview.panX}px, ${preview.panY}px) scale(${preview.zoom})`;
  el("viewer-zoom-reset").textContent = Math.round(preview.zoom * 100) + "%";
  el("viewer-image-wrap").classList.toggle("pannable", preview.zoom > 1);
}
function setZoom(newZoom) {
  if (preview.kind !== "image") return;
  preview.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
  if (preview.zoom <= 1) { preview.panX = 0; preview.panY = 0; }
  applyTransform();
}

async function showPreviewImage() {
  const m = preview.items[preview.index];
  if (!m) return;
  preview.kind = m.isVideo ? "video" : m.isAudio ? "audio" : m.isText ? "text" : "image";

  const img = el("viewer-image");
  const video = el("viewer-video");
  const audio = el("viewer-audio");
  const text = el("viewer-text");

  video.pause(); video.removeAttribute("src"); video.load();
  audio.pause(); audio.removeAttribute("src"); audio.load();

  img.classList.toggle("hidden", preview.kind !== "image");
  video.classList.toggle("hidden", preview.kind !== "video");
  audio.classList.toggle("hidden", preview.kind !== "audio");
  text.classList.toggle("hidden", preview.kind !== "text");

  const showZoom = preview.kind === "image";
  el("viewer-zoom-out").classList.toggle("hidden", !showZoom);
  el("viewer-zoom-reset").classList.toggle("hidden", !showZoom);
  el("viewer-zoom-in").classList.toggle("hidden", !showZoom);
  el("viewer-image-wrap").classList.remove("pannable");
  applyTransform();

  el("viewer-title").textContent = `${matchDisplayPath(m)}  (${preview.index + 1}/${preview.items.length})`;
  const multi = preview.items.length > 1;
  el("viewer-arrow-left").classList.toggle("hidden", !multi);
  el("viewer-arrow-right").classList.toggle("hidden", !multi);
  highlightFilmstrip();

  const myIndex = preview.index;
  img.src = ""; video.removeAttribute("src");
  try {
    const url = await objectUrlFor(m.id);
    if (preview.index !== myIndex) return; // superseded by navigation
    if (preview.kind === "image") img.src = url;
    else if (preview.kind === "video") video.src = url;
    else if (preview.kind === "audio") audio.src = url;
    else if (preview.kind === "text") text.textContent = new TextDecoder().decode(await fetchEntryBytes(findEntryById(m.id)));
  } catch (err) {
    if (preview.kind === "text") text.textContent = `Failed to load: ${err.message}`;
  }
}

function previewGoTo(delta) {
  if (preview.items.length <= 1) return;
  preview.index = (preview.index + delta + preview.items.length) % preview.items.length;
  preview.zoom = 1; preview.panX = 0; preview.panY = 0;
  showPreviewImage();
}
function previewGoToIndex(index) {
  if (index === preview.index) return;
  preview.index = index;
  preview.zoom = 1; preview.panX = 0; preview.panY = 0;
  showPreviewImage();
}

function renderFilmstrip() {
  const strip = el("viewer-filmstrip");
  strip.innerHTML = "";
  strip.classList.toggle("hidden", preview.items.length <= 1);
  if (preview.items.length <= 1) return;

  const start = Math.max(0, preview.index - FILMSTRIP_WINDOW);
  const end = Math.min(preview.items.length - 1, preview.index + FILMSTRIP_WINDOW);
  for (let i = start; i <= end; i += 1) {
    const m = preview.items[i];
    const cell = document.createElement("div");
    cell.className = "filmstrip-item" + (i === preview.index ? " current" : "");
    cell.dataset.index = String(i);
    if (m.isVideo) {
      const img = document.createElement("img");
      img.alt = m.name;
      observeLazy(img, m.thumbnailId || m.id);
      cell.appendChild(img);
    } else if (m.isAudio || m.isText) {
      cell.appendChild(makeIconEl(m.isAudio ? "\u{1F3B5}" : "\u{1F4C4}"));
    } else {
      const img = document.createElement("img");
      img.alt = m.name;
      observeLazy(img, m.id);
      cell.appendChild(img);
    }
    cell.addEventListener("click", () => previewGoToIndex(i));
    strip.appendChild(cell);
  }
  highlightFilmstrip();
}
function highlightFilmstrip() {
  const strip = el("viewer-filmstrip");
  const cells = strip.querySelectorAll(".filmstrip-item");
  let needsRebuild = true;
  cells.forEach((cell) => {
    const isCurrent = Number(cell.dataset.index) === preview.index;
    cell.classList.toggle("current", isCurrent);
    if (isCurrent) { needsRebuild = false; cell.scrollIntoView({ inline: "center", block: "nearest" }); }
  });
  if (needsRebuild && cells.length > 0) renderFilmstrip();
}

el("viewer-arrow-left").addEventListener("click", () => previewGoTo(-1));
el("viewer-arrow-right").addEventListener("click", () => previewGoTo(1));
el("viewer-close").addEventListener("click", closeViewer);
el("viewer-image-wrap").addEventListener("click", (ev) => {
  if (preview.dragMoved) { preview.dragMoved = false; return; }
  if (ev.target === el("viewer-image-wrap")) closeViewer();
});
el("viewer-zoom-in").addEventListener("click", () => setZoom(preview.zoom * ZOOM_STEP));
el("viewer-zoom-out").addEventListener("click", () => setZoom(preview.zoom / ZOOM_STEP));
el("viewer-zoom-reset").addEventListener("click", () => setZoom(1));
el("viewer-image-wrap").addEventListener("wheel", (ev) => {
  if (!isViewerOpen() || preview.kind !== "image") return;
  ev.preventDefault();
  setZoom(preview.zoom * (ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
}, { passive: false });

const viewerWrap = el("viewer-image-wrap");
viewerWrap.addEventListener("pointerdown", (ev) => {
  if (preview.zoom <= 1) return;
  preview.dragging = true;
  preview.dragMoved = false;
  preview.dragStartX = ev.clientX;
  preview.dragStartY = ev.clientY;
  preview.dragOrigPanX = preview.panX;
  preview.dragOrigPanY = preview.panY;
  viewerWrap.classList.add("panning");
  viewerWrap.setPointerCapture(ev.pointerId);
});
viewerWrap.addEventListener("pointermove", (ev) => {
  if (!preview.dragging) return;
  preview.dragMoved = true;
  preview.panX = preview.dragOrigPanX + (ev.clientX - preview.dragStartX);
  preview.panY = preview.dragOrigPanY + (ev.clientY - preview.dragStartY);
  applyTransform();
});
function endDrag(ev) {
  if (!preview.dragging) return;
  preview.dragging = false;
  viewerWrap.classList.remove("panning");
  try { viewerWrap.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
}
viewerWrap.addEventListener("pointerup", endDrag);
viewerWrap.addEventListener("pointercancel", endDrag);

document.addEventListener("keydown", (ev) => {
  if (!isViewerOpen()) return;
  if (!els.previewModal.classList.contains("hidden")) return;
  if (ev.key === "Escape") closeViewer();
  else if (ev.key === "ArrowLeft") previewGoTo(-1);
  else if (ev.key === "ArrowRight") previewGoTo(1);
  else if (ev.key === "+" || ev.key === "=") setZoom(preview.zoom * ZOOM_STEP);
  else if (ev.key === "-") setZoom(preview.zoom / ZOOM_STEP);
  else if (ev.key === "0") setZoom(1);
});

// ---------- Toolbar: Reload / Find Outputs / Find Orphans / search / sort ----------

el("btn-reload").addEventListener("click", () => refresh());

el("btn-find-outputs").addEventListener("click", () => {
  if (state.selectedPromptIndices.size === 0 && !state.includeNonMatching) {
    alert('Select at least one prompt (or "Non-matching") first.');
    return;
  }
  const images = state.gridMode === "input" ? [...state.selectedIds] : [];

  let sourceFolders = null;
  if (state.searchAllFolders) sourceFolders = "*";
  else if (state.selectedFolders.size > 0) sourceFolders = [...state.selectedFolders];
  else if (images.length === 0) {
    alert('Pick Input folder(s), Input image(s), or select "All folders" first.');
    return;
  }

  const allPrompts = state.prompts;
  const wantedIndices = state.selectedPromptIndices;
  const promptFilter = wantedIndices.size > 0 ? [...wantedIndices].map((i) => allPrompts[i]).filter(Boolean) : null;

  const imagePrefixesByFolder = new Map();
  for (const id of images) {
    const entry = findEntryById(id);
    if (!entry) continue;
    const relPath = relPathWithinRoot(entry, "input");
    const slash = relPath.lastIndexOf("/");
    const folder = slash === -1 ? "" : relPath.slice(0, slash);
    if (!imagePrefixesByFolder.has(folder)) imagePrefixesByFolder.set(folder, []);
    imagePrefixesByFolder.get(folder).push(imageDirName(relPath).toLowerCase() + "__");
  }

  const folderSet = new Set();
  if (sourceFolders === "*") for (const f of listInputFolders()) folderSet.add(f);
  else if (sourceFolders) for (const f of sourceFolders) folderSet.add(f);
  for (const f of imagePrefixesByFolder.keys()) folderSet.add(f);

  let results = [];
  for (const folder of folderSet) {
    let folderResults = scanEntries({ root: "output", folder, promptFilter: state.includeNonMatching ? null : promptFilter });
    const prefixes = imagePrefixesByFolder.get(folder);
    if (prefixes) folderResults = folderResults.filter((m) => prefixes.some((p) => m.name.toLowerCase().startsWith(p)));
    if (state.includeNonMatching) {
      folderResults = folderResults
        .map((m) => ({ ...m, promptIndex: matchPromptIndex(m.name, allPrompts) }))
        .filter((m) => wantedIndices.has(m.promptIndex) || m.promptIndex === -1);
    }
    results.push(...folderResults);
  }
  results = sortResults(results, state.sortMode);

  state.matches = results;
  state.gridMode = "outputs";
  state.selectedIds = new Set();
  renderGrid();
  setStatus(`${results.length} output image(s) found.`);
});

el("btn-find-orphans").addEventListener("click", () => {
  let sourceFolders;
  if (state.searchAllFolders) sourceFolders = listInputFolders();
  else if (state.selectedFolders.size > 0) sourceFolders = [...state.selectedFolders];
  else {
    alert('Pick Input folder(s), or select "All folders" first.');
    return;
  }

  const validHashes = state.prompts.map((p) => p.hash);
  let results = [];
  for (const folder of sourceFolders) {
    const inputImages = scanEntries({ root: "input", folder, promptFilter: null });
    const outputImages = scanEntries({ root: "output", folder, promptFilter: null });
    const validPrefixes = inputImages.map((m) => imageDirName(`${folder}/${m.name}`).toLowerCase() + "__");
    for (const m of outputImages) {
      const lower = m.name.toLowerCase();
      const hashOk = validHashes.some((h) => lower.includes(`_${h}__`) || lower.includes(`__${h}__`));
      const imageOk = validPrefixes.some((p) => lower.startsWith(p));
      if (hashOk && imageOk) continue;
      const orphanReason = !hashOk && !imageOk ? "no matching prompt or input image" : !hashOk ? "no matching prompt" : "no matching input image";
      results.push({ ...m, orphanReason });
    }
  }
  results = sortResults(results, state.sortMode);

  state.matches = results;
  state.gridMode = "outputs";
  state.selectedIds = new Set();
  renderGrid();
  setStatus(`${results.length} orphaned output image(s) found (no matching current prompt or input image).`);
});

let searchDebounce = null;
el("search-box").addEventListener("input", (ev) => {
  state.searchText = ev.target.value;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => refreshMatches(), 200);
});
el("sort-select").addEventListener("change", (ev) => {
  state.sortMode = ev.target.value;
  if (state.showVideos) refreshVideos();
  else if (state.showArchive) refreshArchive();
  else refreshMatches();
});

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  if (isViewerOpen()) return;
  if (!els.previewModal.classList.contains("hidden")) return;
  if (document.activeElement && document.activeElement.tagName === "TEXTAREA") return;
  ev.preventDefault();
  el("btn-find-outputs").click();
});

// =====================================================================
// "Other files" - anything not under input/output/videos/archive (the
// prompts.txt entry itself is excluded too - it's surfaced via the
// Prompts panel instead). Same flat grid + modal preview this app
// always had, for misc single uploads and non-media types (SQLite, etc).
// =====================================================================

function isOtherFile(entry) {
  const root = entryRoot(entry);
  if (ROOTS.includes(root)) return false;
  if (/(^|\/)prompts\.txt$/i.test(entry.name)) return false;
  return true;
}

const TYPE_ICON = { video: "\u{1F3AC}", audio: "\u{1F3B5}", application_pdf: "\u{1F4C4}", text: "\u{1F4DD}" };
function iconFor(entry) {
  if (isSqliteFile(entry)) return "\u{1F5C4}️";
  if (entry.type === "application/pdf") return TYPE_ICON.application_pdf;
  const kind = (entry.type || "").split("/")[0];
  return TYPE_ICON[kind] || "\u{1F4E6}";
}

function renderOtherFiles() {
  const others = currentEntries.filter(isOtherFile);
  els.fileList.innerHTML = "";
  els.fileList.className = "file-grid";
  el("other-files-header").querySelector("span:last-child").textContent =
    `Other files (${others.length}, anything not under input/output/videos/archive)`;
  if (others.length === 0) {
    els.fileList.innerHTML = '<li class="empty">None.</li>';
    return;
  }
  for (const entry of [...others].reverse()) {
    const li = document.createElement("li");
    li.className = "file-tile";
    li.title = `${entry.name} · ${formatBytes(entry.size)} · ${new Date(entry.uploadedAt).toLocaleString()}`;
    li.onclick = () => previewEntry(entry);

    const thumb = document.createElement("div");
    thumb.className = "file-thumb";
    if (isImageEntry(entry)) {
      const img = document.createElement("img");
      img.className = "loading";
      img.alt = entry.name;
      observeLazy(img, entry.id);
      img.addEventListener("load", () => img.classList.remove("loading"));
      thumb.appendChild(img);
    } else {
      thumb.appendChild(Object.assign(document.createElement("div"), { className: "file-icon", textContent: iconFor(entry) }));
    }

    const name = document.createElement("span");
    name.className = "file-tile-name";
    name.textContent = entry.name;

    const actions = document.createElement("div");
    actions.className = "file-tile-actions";
    const downloadBtn = document.createElement("button");
    downloadBtn.textContent = "⭳";
    downloadBtn.title = "Download";
    downloadBtn.onclick = (e) => { e.stopPropagation(); downloadEntry(entry); };
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "✕";
    deleteBtn.title = "Remove";
    deleteBtn.className = "danger";
    deleteBtn.onclick = (e) => { e.stopPropagation(); removeEntry(entry.id); };
    actions.append(downloadBtn, deleteBtn);

    li.append(thumb, name, actions);
    els.fileList.appendChild(li);
  }
}
els.otherFilesHeader.addEventListener("click", () => {
  const collapsed = els.otherFilesBody.classList.toggle("collapsed");
  els.otherFilesArrow.classList.toggle("collapsed", collapsed);
});

// =====================================================================
// Upload / download / remove / SQLite preview (unchanged storage logic)
// =====================================================================

function guessType(file) {
  if (file.type) return file.type;
  if (/\.(sqlite3?|db3?)$/i.test(file.name)) return "application/vnd.sqlite3";
  return "application/octet-stream";
}

async function handleUpload(file) {
  const type = guessType(file);
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const id = crypto.randomUUID();

  let entry;
  if (fileBytes.length <= CHUNK_SIZE) {
    els.uploadStatus.textContent = `Encrypting ${file.name}…`;
    const encrypted = await encryptBuffer(fileBytes, currentSession.key);
    els.uploadStatus.textContent = `Uploading ${file.name}…`;
    await putFile({ ...currentSession, path: blobPath(currentSession, id), bytes: encrypted, message: "store: blob" });
    entry = { id, name: file.name, type, size: file.size, uploadedAt: new Date().toISOString() };
  } else {
    const chunks = splitIntoChunks(fileBytes);
    let uploaded = 0;
    await runWithConcurrency(chunks, CHUNK_UPLOAD_CONCURRENCY, async (chunk, index) => {
      const encrypted = await encryptBuffer(chunk, currentSession.key);
      await putFile({ ...currentSession, path: chunkPath(currentSession, id, index), bytes: encrypted, message: `store: blob chunk ${index}/${chunks.length}` });
      uploaded += 1;
      els.uploadStatus.textContent = `Uploading ${file.name}… (${uploaded}/${chunks.length} chunks)`;
    });
    entry = { id, name: file.name, type, size: file.size, uploadedAt: new Date().toISOString(), chunked: true, chunkCount: chunks.length };
  }

  els.uploadStatus.textContent = "Updating index…";
  const nextEntries = [...currentEntries, entry];
  await saveManifest(currentSession, nextEntries, currentManifestSha);
  currentEntries = nextEntries;
  currentManifestSha = null;
  els.uploadStatus.textContent = `Done: ${file.name}`;
  await afterManifestChange();
}

async function downloadEntry(entry) {
  let fileBytes;
  try { fileBytes = await fetchEntryBytes(entry); } catch (err) { alert(err.message); return; }
  const blob = new Blob([fileBytes], { type: entry.type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = entry.name;
  a.click();
  URL.revokeObjectURL(url);
}

let previewSqliteDb = null;
function closePreview() {
  els.previewModal.classList.add("hidden");
  els.previewBody.innerHTML = "";
  if (previewSqliteDb) { previewSqliteDb.close(); previewSqliteDb = null; }
}

async function previewEntry(entry) {
  els.previewTitle.textContent = entry.name;
  els.previewBody.innerHTML = '<p class="hint">Decrypting…</p>';
  els.previewModal.classList.remove("hidden");

  let fileBytes;
  try { fileBytes = await fetchEntryBytes(entry); } catch (err) {
    els.previewBody.innerHTML = `<p class="error">${err.message}</p>`;
    return;
  }

  if (isSqliteFile(entry)) {
    previewSqliteDb = await renderSqlitePreview(fileBytes, els.previewBody, {
      onSave: async (newDbBytes) => {
        const path = blobPath(currentSession, entry.id);
        const current = await getFile({ ...currentSession, path });
        const encrypted = await encryptBuffer(newDbBytes, currentSession.key);
        await putFile({ ...currentSession, path, bytes: encrypted, message: "edit: blob", sha: current?.sha });
        entry.size = newDbBytes.length;
        entry.uploadedAt = new Date().toISOString();
        const { sha: manifestSha } = await loadManifest(currentSession);
        await saveManifest(currentSession, currentEntries, manifestSha);
        renderOtherFiles();
      },
    });
    return;
  }

  const blob = new Blob([fileBytes], { type: entry.type });
  const url = URL.createObjectURL(blob);
  els.previewBody.innerHTML = "";
  const kind = (entry.type || "").split("/")[0];
  let mediaEl;
  if (kind === "image") { mediaEl = document.createElement("img"); mediaEl.src = url; }
  else if (kind === "video") { mediaEl = document.createElement("video"); mediaEl.src = url; mediaEl.controls = true; }
  else if (kind === "audio") { mediaEl = document.createElement("audio"); mediaEl.src = url; mediaEl.controls = true; }
  else if (entry.type === "application/pdf" || kind === "text") { mediaEl = document.createElement("iframe"); mediaEl.src = url; }
  else {
    mediaEl = document.createElement("p");
    mediaEl.className = "hint";
    mediaEl.textContent = `No inline preview for ${entry.type || "this file type"} - use Download instead.`;
  }
  els.previewBody.appendChild(mediaEl);
}

async function removeEntry(id) {
  if (!confirm("Remove this from your file list? (The underlying git history isn't erased.)")) return;
  const nextEntries = currentEntries.filter((e) => e.id !== id);
  const { sha } = await loadManifest(currentSession);
  await saveManifest(currentSession, nextEntries, sha);
  currentEntries = nextEntries;
  await afterManifestChange();
}

els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files[0];
  els.fileInput.value = "";
  if (!file) return;
  try { await handleUpload(file); } catch (err) { els.uploadStatus.textContent = `Upload failed: ${err.message}`; }
});
els.previewClose.addEventListener("click", closePreview);
els.previewModal.addEventListener("click", (e) => { if (e.target === els.previewModal) closePreview(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.previewModal.classList.contains("hidden") && !isViewerOpen()) closePreview();
});

// =====================================================================
// Boot / login / logout
// =====================================================================

async function afterManifestChange() {
  state.inputFolders = listInputFolders();
  renderFolderList();
  await loadPrompts();
  renderOtherFiles();
  if (state.showVideos) await refreshVideos();
  else if (state.showArchive) await refreshArchive();
  else await refreshMatches();
}

async function refresh() {
  revokeAllObjectUrls();
  setStatus("Loading…");
  const { entries, sha } = await loadManifest(currentSession);
  currentEntries = entries;
  currentManifestSha = sha;
  // afterManifestChange() -> refreshMatches()/refreshVideos()/refreshArchive() already
  // sets a specific status ("N input image(s) found.", "Pick a folder...", etc.) -
  // setting a generic one after it would just clobber that.
  await afterManifestChange();
}

async function resolveToken({ password }) {
  const stored = await getPublicFile({ owner: OWNER, repo: REPO, path: `blobs/${FOLDER}/pat.enc` });
  if (!stored) throw new Error(`No account set up yet - run "node src/cli.js store-pat ${FOLDER} <pat>" first.`);
  const decrypted = await decryptBuffer(stored.bytes, password);
  return new TextDecoder().decode(decrypted);
}

function showApp(session) {
  currentSession = session;
  els.loginScreen.classList.add("hidden");
  els.app.classList.remove("hidden");
  applySectionCollapse();
  renderVideosSection();
  renderArchiveSection();
  refresh().catch((err) => setStatus(`Failed to load: ${err.message}`));
}

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = els.loginPassword.value;
  if (!password) { els.loginError.textContent = "Password is required."; return; }
  els.loginError.textContent = "";
  els.loginStatus.textContent = "Logging in…";
  try {
    const token = await resolveToken({ password });
    els.loginStatus.textContent = "";
    const session = { token, owner: OWNER, repo: REPO, folder: FOLDER, key: password };
    saveSession(session);
    showApp(session);
  } catch (err) {
    els.loginStatus.textContent = "";
    els.loginError.textContent = err.message.includes("No account set up") ? err.message : "Wrong password.";
  }
});

els.logoutBtn.addEventListener("click", () => {
  clearSession();
  currentSession = null;
  revokeAllObjectUrls();
  els.app.classList.add("hidden");
  els.loginScreen.classList.remove("hidden");
});

const existingSession = loadSession();
if (existingSession) showApp(existingSession);
