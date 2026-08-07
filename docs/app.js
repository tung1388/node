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

const OWNER = "tung1388";
const REPO = "node";

// This is a single-folder instance - always the same folder, so the
// login form only ever asks for the password (the encryption key).
const FOLDER = "node";

const STORAGE_KEY = "githost.session";

const els = {
  loginForm: document.getElementById("login-form"),
  loginPassword: document.getElementById("login-password"),
  loginStatus: document.getElementById("login-status"),
  loginError: document.getElementById("login-error"),
  app: document.getElementById("app"),
  whoami: document.getElementById("whoami"),
  logoutBtn: document.getElementById("logout-btn"),
  fileInput: document.getElementById("file-input"),
  uploadStatus: document.getElementById("upload-status"),
  fileList: document.getElementById("file-list"),
  refreshBtn: document.getElementById("refresh-btn"),
  rootTabs: document.getElementById("root-tabs"),
  promptsPanel: document.getElementById("prompts-panel"),
  previewModal: document.getElementById("preview-modal"),
  previewTitle: document.getElementById("preview-title"),
  previewBody: document.getElementById("preview-body"),
  previewClose: document.getElementById("preview-close"),
};

// ---------------------------------------------------------------------
// Media browsing: entries are grouped by treating their `name` as a
// path - "output/myshoot/img_HASH__1.png" groups under root "output",
// folder "myshoot". This is a naming convention, not a manifest schema
// change (see src/cli.js's upload-folder, which is what actually
// produces path-like names for a real bulk upload). Entries with no "/"
// (a plain single-file upload) fall into an "(uploads)" bucket, so
// today's flat behavior is unchanged when nothing uses the convention.
// ---------------------------------------------------------------------

const UNGROUPED_ROOT = "(uploads)";

function entryRoot(entry) {
  const slash = entry.name.indexOf("/");
  return slash === -1 ? UNGROUPED_ROOT : entry.name.slice(0, slash);
}

function entryFolder(entry) {
  const parts = entry.name.split("/");
  return parts.length > 2 ? parts.slice(1, -1).join("/") : null;
}

// Mirrors lib.js's promptHash()/matchPromptIndex() (Node/webapp side) so
// prompt-hash-tagged filenames (createJobs.js's "_<hash>__..." naming)
// still filter correctly here.
async function promptHash(text) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}

async function parsePrompts(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return Promise.all(lines.map(async (line, index) => ({ index, text: line, hash: await promptHash(line) })));
}

function matchesPrompt(entryName, hash) {
  const lower = entryName.toLowerCase();
  return lower.includes(`_${hash}__`) || lower.includes(`__${hash}__`);
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveSession(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

function manifestPath(session) {
  return `blobs/${session.folder}/manifest.enc`;
}

function blobPath(session, id) {
  return `blobs/${session.folder}/${id}.enc`;
}

function chunkPath(session, id, index) {
  return `blobs/${session.folder}/${id}/${index}.enc`;
}

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
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const TYPE_ICON = { video: "🎬", audio: "🎵", application_pdf: "📄", text: "📝" };
function iconFor(entry) {
  if (isSqliteFile(entry)) return "🗄️";
  if (entry.type === "application/pdf") return TYPE_ICON.application_pdf;
  const kind = (entry.type || "").split("/")[0];
  return TYPE_ICON[kind] || "📦";
}

// Object URLs created for auto-loaded image thumbnails - tracked so they
// can all be revoked before the next render, otherwise every refresh
// leaks the previous batch (Blob URLs aren't garbage-collected on their
// own).
let thumbnailObjectUrls = [];
function revokeThumbnails() {
  for (const url of thumbnailObjectUrls) URL.revokeObjectURL(url);
  thumbnailObjectUrls = [];
}

async function loadThumbnail(entry, imgEl) {
  try {
    const fileBytes = await fetchEntryBytes(entry);
    const url = URL.createObjectURL(new Blob([fileBytes], { type: entry.type }));
    thumbnailObjectUrls.push(url);
    imgEl.src = url;
    imgEl.classList.remove("loading");
  } catch {
    imgEl.replaceWith(Object.assign(document.createElement("div"), { className: "file-icon", textContent: "⚠️" }));
  }
}

let currentRoot = null; // null/"all" = no root filter
let currentPromptFilter = null; // hash string, or null for no filter
let currentPrompts = null; // [{index, text, hash}] from the prompts.txt entry, or null if there isn't one

function findPromptsEntry(entries) {
  return entries.find((e) => /(^|\/)prompts\.txt$/i.test(e.name));
}

async function ensurePromptsLoaded(entries) {
  const promptsEntry = findPromptsEntry(entries);
  if (!promptsEntry) {
    currentPrompts = null;
    return;
  }
  try {
    const bytes = await fetchEntryBytes(promptsEntry);
    currentPrompts = await parsePrompts(new TextDecoder().decode(bytes));
  } catch {
    currentPrompts = null; // missing/corrupt prompts.txt shouldn't break browsing everything else
  }
}

function renderRootTabs(entries) {
  const roots = [...new Set(entries.map(entryRoot))].sort();
  els.rootTabs.innerHTML = "";
  if (roots.length <= 1) {
    els.rootTabs.classList.add("hidden");
    return;
  }
  els.rootTabs.classList.remove("hidden");
  const addTab = (label, value) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.className = (currentRoot ?? "all") === value ? "active" : "";
    btn.onclick = () => { currentRoot = value; renderList(currentEntries); };
    els.rootTabs.appendChild(btn);
  };
  addTab("All", "all");
  for (const root of roots) addTab(root, root);
}

function renderPromptsPanel() {
  els.promptsPanel.innerHTML = "";
  if (!currentPrompts || currentPrompts.length === 0) {
    els.promptsPanel.classList.add("hidden");
    return;
  }
  els.promptsPanel.classList.remove("hidden");
  for (const prompt of currentPrompts) {
    const btn = document.createElement("button");
    btn.textContent = prompt.text.length > 40 ? `${prompt.text.slice(0, 40)}…` : prompt.text;
    btn.title = prompt.text;
    btn.className = currentPromptFilter === prompt.hash ? "active" : "";
    btn.onclick = () => {
      currentPromptFilter = currentPromptFilter === prompt.hash ? null : prompt.hash;
      renderList(currentEntries);
    };
    els.promptsPanel.appendChild(btn);
  }
}

async function renderList(entries) {
  await ensurePromptsLoaded(entries);
  renderRootTabs(entries);
  renderPromptsPanel();

  let visible = entries;
  if (currentRoot && currentRoot !== "all") visible = visible.filter((e) => entryRoot(e) === currentRoot);
  if (currentPromptFilter) visible = visible.filter((e) => matchesPrompt(e.name, currentPromptFilter));

  revokeThumbnails();
  els.fileList.innerHTML = "";
  els.fileList.className = "file-grid";
  if (visible.length === 0) {
    els.fileList.innerHTML = '<li class="empty">No files yet.</li>';
    return;
  }

  // Grouping by folder only makes sense once a specific root is picked
  // (mixing roots' folder names in one list would be confusing) - "All"
  // and the flat "(uploads)"-only case keep the original newest-first list.
  const grouped = currentRoot && currentRoot !== "all";
  const ordered = grouped
    ? [...visible].sort((a, b) =>
        (entryFolder(a) || "").localeCompare(entryFolder(b) || "", undefined, { numeric: true }) ||
        a.name.localeCompare(b.name, undefined, { numeric: true })
      )
    : [...visible].reverse();

  let lastFolder;
  for (const entry of ordered) {
    if (grouped) {
      const folder = entryFolder(entry);
      if (folder !== lastFolder) {
        lastFolder = folder;
        const heading = document.createElement("li");
        heading.className = "folder-heading";
        heading.textContent = folder || "(root)";
        els.fileList.appendChild(heading);
      }
    }

    const li = document.createElement("li");
    li.className = "file-tile";
    li.title = `${entry.name} · ${formatBytes(entry.size)} · ${new Date(entry.uploadedAt).toLocaleString()}`;
    li.onclick = () => previewEntry(entry);

    const thumb = document.createElement("div");
    thumb.className = "file-thumb";
    if (entry.type?.startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "loading";
      img.alt = entry.name;
      thumb.appendChild(img);
      loadThumbnail(entry, img); // fire-and-forget - fills in once decrypted
    } else {
      const icon = document.createElement("div");
      icon.className = "file-icon";
      icon.textContent = iconFor(entry);
      thumb.appendChild(icon);
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

let currentSession = null;
let currentEntries = [];
let currentManifestSha = null;

async function refresh() {
  els.fileList.innerHTML = '<li class="empty">Loading…</li>';
  const { entries, sha } = await loadManifest(currentSession);
  currentEntries = entries;
  currentManifestSha = sha;
  renderList(entries);
}

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
    // No envelope: name/type live on the manifest entry, same convention
    // as chunked uploads (and what the Node CLI's upload-folder writes) -
    // one consistent format regardless of which side uploaded a file.
    els.uploadStatus.textContent = `Encrypting ${file.name}…`;
    const encrypted = await encryptBuffer(fileBytes, currentSession.key);
    els.uploadStatus.textContent = `Uploading ${file.name}…`;
    await putFile({
      ...currentSession,
      path: blobPath(currentSession, id),
      bytes: encrypted,
      message: "store: blob", // never the real filename - commit messages sit unencrypted in a public repo
    });
    entry = { id, name: file.name, type, size: file.size, uploadedAt: new Date().toISOString() };
  } else {
    // Chunked: no packEnvelope per chunk (name/type already live on the
    // manifest entry - see system.md §3), just raw bytes encrypted
    // independently per chunk (own random IV each).
    const chunks = splitIntoChunks(fileBytes);
    let uploaded = 0;
    await runWithConcurrency(chunks, CHUNK_UPLOAD_CONCURRENCY, async (chunk, index) => {
      const encrypted = await encryptBuffer(chunk, currentSession.key);
      await putFile({
        ...currentSession,
        path: chunkPath(currentSession, id, index),
        bytes: encrypted,
        message: `store: blob chunk ${index}/${chunks.length}`,
      });
      uploaded += 1;
      els.uploadStatus.textContent = `Uploading ${file.name}… (${uploaded}/${chunks.length} chunks)`;
    });
    entry = {
      id, name: file.name, type, size: file.size, uploadedAt: new Date().toISOString(),
      chunked: true, chunkCount: chunks.length,
    };
  }

  els.uploadStatus.textContent = "Updating index…";
  const nextEntries = [...currentEntries, entry];
  await saveManifest(currentSession, nextEntries, currentManifestSha);
  currentEntries = nextEntries;
  currentManifestSha = null; // stale after the write above; refresh() re-fetches it if needed

  els.uploadStatus.textContent = `Done: ${file.name}`;
  renderList(currentEntries);
}

// Fetch + decrypt + unpack an uploaded entry - shared by download and
// preview, which only differ in what they do with the resulting bytes.
async function fetchEntryBytes(entry) {
  if (entry.chunked) {
    const chunks = await Promise.all(
      Array.from({ length: entry.chunkCount }, async (_, index) => {
        const stored = await getFile({ ...currentSession, path: chunkPath(currentSession, entry.id, index) });
        if (!stored) {
          throw new Error(`${entry.name} is missing chunk ${index} (was it deleted outside this app?).`);
        }
        return decryptBuffer(stored.bytes, currentSession.key);
      })
    );
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  const stored = await getFile({ ...currentSession, path: blobPath(currentSession, entry.id) });
  if (!stored) {
    throw new Error(`${entry.name} is missing from the repo (was it deleted outside this app?).`);
  }
  return decryptBuffer(stored.bytes, currentSession.key);
}

async function downloadEntry(entry) {
  let fileBytes;
  try {
    fileBytes = await fetchEntryBytes(entry);
  } catch (err) {
    alert(err.message);
    return;
  }
  const blob = new Blob([fileBytes], { type: entry.type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = entry.name;
  a.click();
  URL.revokeObjectURL(url);
}

// Tracks the last object URL / open sql.js Database shown in the preview
// modal so both can be released when replaced or closed - otherwise each
// preview leaks memory (an object URL, or WASM-heap memory for a SQLite
// DB) for as long as the page stays open.
let previewObjectUrl = null;
let previewSqliteDb = null;

function closePreview() {
  els.previewModal.classList.add("hidden");
  els.previewBody.innerHTML = "";
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
  if (previewSqliteDb) {
    previewSqliteDb.close();
    previewSqliteDb = null;
  }
}

async function previewEntry(entry) {
  els.previewTitle.textContent = entry.name;
  els.previewBody.innerHTML = '<p class="hint">Decrypting…</p>';
  els.previewModal.classList.remove("hidden");

  let fileBytes;
  try {
    fileBytes = await fetchEntryBytes(entry);
  } catch (err) {
    els.previewBody.innerHTML = `<p class="error">${err.message}</p>`;
    return;
  }

  if (isSqliteFile(entry)) {
    previewSqliteDb = await renderSqlitePreview(fileBytes, els.previewBody, {
      onSave: async (newDbBytes) => {
        // Same overwrite pattern as any other edit: re-fetch the blob's
        // current sha right before writing (not the one from when the
        // preview opened) so a concurrent change elsewhere isn't clobbered
        // blind, then update the manifest entry's size/uploadedAt in place.
        const path = blobPath(currentSession, entry.id);
        const current = await getFile({ ...currentSession, path });
        const encrypted = await encryptBuffer(newDbBytes, currentSession.key);
        await putFile({ ...currentSession, path, bytes: encrypted, message: "edit: blob", sha: current?.sha });

        entry.size = newDbBytes.length;
        entry.uploadedAt = new Date().toISOString();
        const { sha: manifestSha } = await loadManifest(currentSession);
        await saveManifest(currentSession, currentEntries, manifestSha);
        renderList(currentEntries);
      },
    });
    return;
  }

  const blob = new Blob([fileBytes], { type: entry.type });
  const url = URL.createObjectURL(blob);
  previewObjectUrl = url;
  els.previewBody.innerHTML = "";

  const kind = entry.type.split("/")[0];
  let el;
  if (kind === "image") {
    el = document.createElement("img");
    el.src = url;
  } else if (kind === "video") {
    el = document.createElement("video");
    el.src = url;
    el.controls = true;
  } else if (kind === "audio") {
    el = document.createElement("audio");
    el.src = url;
    el.controls = true;
  } else if (entry.type === "application/pdf" || kind === "text") {
    // Browsers render PDFs and plain text natively inside an <iframe>.
    el = document.createElement("iframe");
    el.src = url;
  } else {
    el = document.createElement("p");
    el.className = "hint";
    el.textContent = `No inline preview for ${entry.type || "this file type"} - use Download instead.`;
  }
  els.previewBody.appendChild(el);
}

async function removeEntry(id) {
  // Removes the entry from the index only - the encrypted blob itself
  // stays in git history (git doesn't cheaply "forget" old commits).
  // Good enough for "stop showing it in the list"; not a real delete.
  if (!confirm("Remove this from your file list? (The underlying git history isn't erased.)")) return;
  const nextEntries = currentEntries.filter((e) => e.id !== id);
  const { sha } = await loadManifest(currentSession); // re-fetch sha to avoid a stale write
  await saveManifest(currentSession, nextEntries, sha);
  currentEntries = nextEntries;
  renderList(currentEntries);
}

function showApp(session) {
  currentSession = session;
  els.loginForm.classList.add("hidden");
  els.app.classList.remove("hidden");
  els.whoami.textContent = "Logged in";
  refresh().catch((err) => {
    els.fileList.innerHTML = `<li class="empty error">Failed to load: ${err.message}</li>`;
  });
}

// Fetches blobs/<FOLDER>/pat.enc unauthenticated (getPublicFile - no
// token exists yet at this point) and decrypts it with the entered
// password to recover the real GitHub PAT stored via `store-pat`. This
// is the one request in the whole app that isn't authenticated.
async function resolveToken({ password }) {
  const stored = await getPublicFile({ owner: OWNER, repo: REPO, path: `blobs/${FOLDER}/pat.enc` });
  if (!stored) {
    throw new Error(`No account set up yet - run "node src/cli.js store-pat ${FOLDER} <pat>" first.`);
  }
  const decrypted = await decryptBuffer(stored.bytes, password);
  return new TextDecoder().decode(decrypted);
}

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = els.loginPassword.value;

  if (!password) {
    els.loginError.textContent = "Password is required.";
    return;
  }

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
    // A wrong password still fetches pat.enc fine (it's public) but fails
    // to decrypt it - GCM's auth tag check throws, which reads to the
    // user as a generic "operation failed" from SubtleCrypto, so we give
    // a clearer message for the common case instead of the raw error.
    els.loginError.textContent = err.message.includes("No account set up")
      ? err.message
      : "Wrong password.";
  }
});

els.logoutBtn.addEventListener("click", () => {
  clearSession();
  currentSession = null;
  els.app.classList.add("hidden");
  els.loginForm.classList.remove("hidden");
});

els.refreshBtn.addEventListener("click", () => {
  refresh().catch((err) => alert(`Refresh failed: ${err.message}`));
});

els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files[0];
  els.fileInput.value = "";
  if (!file) return;
  try {
    await handleUpload(file);
  } catch (err) {
    els.uploadStatus.textContent = `Upload failed: ${err.message}`;
  }
});

els.previewClose.addEventListener("click", closePreview);
els.previewModal.addEventListener("click", (e) => {
  if (e.target === els.previewModal) closePreview(); // click on the dimmed backdrop, not the panel itself
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.previewModal.classList.contains("hidden")) closePreview();
});

const existingSession = loadSession();
if (existingSession) showApp(existingSession);