'use strict';

// Frontend for the Image Sorter web app. No framework/bundler - plain DOM + fetch.

const state = {
  config: { inputRoot: '', outputRoot: '', videosRoot: '', archiveRoot: '', promptFile: '' },
  // Only Input (raw source photos) is browsed directly. Output is never browsed on its own -
  // "Find Outputs" derives the Output folder(s) from whatever Input folder(s)/image(s) (or
  // "all folders") + prompt(s) you picked, since compress.js/createJobs.js mirror Input's
  // folder names 1:1 into Output.
  inputFolders: [],
  inputSectionOpen: true,
  // Multiple folders can be selected at once (ctrl/shift-click).
  selectedFolders: new Set(),
  lastClickedFolderIndex: null,
  // Videos and Archive are separate flat buckets (see videos/serve-videos.js) - no
  // folders/prompts, just an on/off toggle each, mutually exclusive with Input browsing (and
  // each other) in the same grid.
  showVideos: false,
  videosSectionOpen: true,
  showArchive: false,
  archiveSectionOpen: true,
  prompts: [],
  selectedPromptIndices: new Set(),
  includeNonMatching: false, // also include outputs matching none of the current prompts
  searchAllFolders: false, // "all folders" = the whole Input root
  sortMode: 'name',
  searchText: '',
  matches: [],
  gridMode: 'input', // 'input' (browsing Input) | 'videos' | 'archive' | 'outputs' (a Find Outputs result set)
  selectedIds: new Set(),
  lastClickedIndex: null,
  collapsedFolderGroups: new Set(), // group keys (folder, or folder/subpath) collapsed in the grid
};

const el = (id) => document.getElementById(id);
const statusEl = el('status');

function setStatus(text) {
  statusEl.textContent = text;
}

async function api(pathAndQuery, options) {
  const res = await fetch(pathAndQuery, options);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

async function apiJson(pathAndQuery, options) {
  const res = await api(pathAndQuery, options);
  return res.json();
}

// ---------- Config ----------

async function loadConfig() {
  state.config = await apiJson('/api/config');
}

async function saveConfigPatch(patch) {
  state.config = await apiJson('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// ---------- Folder / prompt lists ----------

async function loadInputFolders() {
  state.inputFolders = await apiJson('/api/folders?root=input');
  renderFolderList();
}

async function loadPrompts() {
  state.prompts = await apiJson('/api/prompts');
  renderPromptList();
}

// Shared row builder for the Input/Prompt sidebar lists: a checkmark (shown only once
// selected) + the label text, ellipsis-truncated.
function buildListItemRow(label, isSelected) {
  const div = document.createElement('div');
  div.className = 'list-item' + (isSelected ? ' selected' : '');

  const check = document.createElement('span');
  check.className = 'list-item-check';
  check.textContent = isSelected ? '✓' : '';
  div.appendChild(check);

  const text = document.createElement('span');
  text.className = 'list-item-text';
  text.textContent = label;
  div.appendChild(text);

  return div;
}

function renderFolderList() {
  const container = el('input-folder-list');
  container.innerHTML = '';

  const allRow = buildListItemRow('All folders', state.searchAllFolders);
  allRow.classList.add('list-item-pinned');
  allRow.addEventListener('click', () => toggleAllFolders());
  container.appendChild(allRow);

  state.inputFolders.forEach((f, i) => {
    // While "All folders" is active, every folder reads as selected too - it's what's actually
    // being queried, even though state.selectedFolders itself is untouched underneath it.
    const isSelected = state.searchAllFolders || state.selectedFolders.has(f.name);
    const div = buildListItemRow(`${i + 1}: ${f.name}`, isSelected);
    div.addEventListener('click', (ev) => onFolderClick(ev, i));
    container.appendChild(div);
  });
}

// Pinned "All folders" row (top of the Input list) replaces the old standalone checkbox -
// same state.searchAllFolders flag, just surfaced as a list item like everything else.
function toggleAllFolders() {
  state.searchAllFolders = !state.searchAllFolders;
  exitVideosMode();
  exitArchiveMode();
  renderFolderList();
  return refreshMatches();
}

// Click toggles this folder into/out of the selection (checkbox-style, like Quick Select -
// no modifier key needed to multi-select). Shift-click extends a range from the last click.
function onFolderClick(ev, index) {
  const name = state.inputFolders[index].name;
  const set = state.selectedFolders;

  if (ev.shiftKey && state.lastClickedFolderIndex !== null) {
    const [a, b] = [state.lastClickedFolderIndex, index].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) set.add(state.inputFolders[i].name);
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

// ---------- Videos (flat bucket, see videos/serve-videos.js) ----------

function renderVideosSection() {
  const container = el('videos-list');
  container.innerHTML = '';
  const row = buildListItemRow('All videos', state.showVideos);
  row.addEventListener('click', () => toggleVideos());
  container.appendChild(row);
}

function renderArchiveSection() {
  const container = el('archive-list');
  container.innerHTML = '';
  const row = buildListItemRow('All archive', state.showArchive);
  row.addEventListener('click', () => toggleArchive());
  container.appendChild(row);
}

// Input browsing, Videos, and Archive are mutually exclusive in the same grid - turning one on
// turns the other two off, without touching Input's own folder/prompt selection state.
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
  return refreshVideos();
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
  return refreshArchive();
}

async function refreshVideos() {
  const mySeq = ++refreshSeq;

  if (!state.showVideos) {
    state.matches = [];
    renderGrid();
    setStatus('Select "All videos" to browse the videos folder.');
    return;
  }

  setStatus('Scanning videos...');
  let results;
  try {
    results = await apiJson('/api/matches?root=videos');
  } catch (err) {
    setStatus('Error: ' + err.message);
    return;
  }
  if (mySeq !== refreshSeq) return; // a newer request superseded this one

  state.matches = results;
  state.gridMode = 'videos';
  state.selectedIds = new Set([...state.selectedIds].filter((id) => results.some((m) => m.id === id)));
  renderGrid();
  setStatus(`${results.length} video(s) found.`);
}

async function refreshArchive() {
  const mySeq = ++refreshSeq;

  if (!state.showArchive) {
    state.matches = [];
    renderGrid();
    setStatus('Select "All archive" to browse the archive folder.');
    return;
  }

  setStatus('Scanning archive...');
  let results;
  try {
    results = await apiJson('/api/matches?root=archive');
  } catch (err) {
    setStatus('Error: ' + err.message);
    return;
  }
  if (mySeq !== refreshSeq) return; // a newer request superseded this one

  state.matches = results;
  state.gridMode = 'archive';
  state.selectedIds = new Set([...state.selectedIds].filter((id) => results.some((m) => m.id === id)));
  renderGrid();
  setStatus(`${results.length} archive item(s) found.`);
}

function toggleSection() {
  state.inputSectionOpen = !state.inputSectionOpen;
  applySectionCollapse();
}

function toggleVideosSection() {
  state.videosSectionOpen = !state.videosSectionOpen;
  applySectionCollapse();
}

function toggleArchiveSection() {
  state.archiveSectionOpen = !state.archiveSectionOpen;
  applySectionCollapse();
}

function applySectionCollapse() {
  el('input-section').classList.toggle('collapsed', !state.inputSectionOpen);
  el('input-folder-list').classList.toggle('collapsed', !state.inputSectionOpen);
  el('input-section-arrow').classList.toggle('collapsed', !state.inputSectionOpen);
  el('videos-section').classList.toggle('collapsed', !state.videosSectionOpen);
  el('videos-list').classList.toggle('collapsed', !state.videosSectionOpen);
  el('videos-section-arrow').classList.toggle('collapsed', !state.videosSectionOpen);
  el('archive-section').classList.toggle('collapsed', !state.archiveSectionOpen);
  el('archive-list').classList.toggle('collapsed', !state.archiveSectionOpen);
  el('archive-section-arrow').classList.toggle('collapsed', !state.archiveSectionOpen);
}

// ---------- Right panel (Prompts) resize ----------

const RIGHT_PANEL_MIN = 160;
const RIGHT_PANEL_MAX = 700;

(function initRightResizer() {
  const resizer = el('right-resizer');
  const panel = el('right-panel');
  let dragging = false;

  resizer.addEventListener('pointerdown', (ev) => {
    dragging = true;
    resizer.classList.add('dragging');
    resizer.setPointerCapture(ev.pointerId);
  });
  resizer.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const width = Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, window.innerWidth - ev.clientX));
    panel.style.flexBasis = width + 'px';
  });
  function endDrag(ev) {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    try { resizer.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
  }
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
})();

el('input-section-header').addEventListener('click', () => toggleSection());
el('videos-section-header').addEventListener('click', () => toggleVideosSection());
el('archive-section-header').addEventListener('click', () => toggleArchiveSection());

function renderPromptList() {
  const container = el('prompt-list');
  container.innerHTML = '';

  // Pinned "Non-matching" - outputs whose filename hash doesn't match any current prompt at
  // all, unioned in alongside whichever real prompts are ticked below.
  const nonMatchingRow = buildListItemRow('Non-matching (no prompt match)', state.includeNonMatching);
  nonMatchingRow.classList.add('list-item-pinned');
  nonMatchingRow.addEventListener('click', () => {
    state.includeNonMatching = !state.includeNonMatching;
    renderPromptList();
  });
  container.appendChild(nonMatchingRow);

  state.prompts.forEach((p) => {
    const isSelected = state.selectedPromptIndices.has(p.index);
    const div = buildListItemRow(`${p.index}: ${p.text}`, isSelected);
    div.title = p.text;
    div.addEventListener('click', () => {
      // Prompts don't affect Input browsing - they're only read when "Find Outputs" runs -
      // so toggling one just updates the checklist, no re-fetch needed here.
      if (state.selectedPromptIndices.has(p.index)) state.selectedPromptIndices.delete(p.index);
      else state.selectedPromptIndices.add(p.index);
      renderPromptList();
    });
    container.appendChild(div);
  });
}

// "All" = every real prompt plus Non-matching, since together they cover every possible output
// regardless of prompt-match status.
el('btn-prompts-all').addEventListener('click', () => {
  state.prompts.forEach((p) => state.selectedPromptIndices.add(p.index));
  state.includeNonMatching = true;
  renderPromptList();
});
el('btn-prompts-none').addEventListener('click', () => {
  state.selectedPromptIndices.clear();
  state.includeNonMatching = false;
  renderPromptList();
});

// ---------- Matches / grid (Input browsing) ----------

let refreshSeq = 0;

async function refreshMatches() {
  const mySeq = ++refreshSeq;

  if (!state.searchAllFolders && state.selectedFolders.size === 0) {
    state.matches = [];
    renderGrid();
    setStatus('Pick one or more Input folders to see their images, or select "All folders" at the top of the list.');
    return;
  }

  const params = new URLSearchParams();
  params.set('root', 'input');
  params.set('folder', state.searchAllFolders ? '*' : [...state.selectedFolders].join(','));
  if (state.searchText) params.set('search', state.searchText);
  params.set('sort', state.sortMode);

  setStatus('Scanning...');
  let results;
  try {
    results = await apiJson('/api/matches?' + params.toString());
  } catch (err) {
    setStatus('Error: ' + err.message);
    return;
  }
  if (mySeq !== refreshSeq) return; // a newer request superseded this one

  state.matches = results;
  state.gridMode = 'input';
  state.selectedIds = new Set([...state.selectedIds].filter((id) => results.some((m) => m.id === id)));
  renderGrid();
  setStatus(`${results.length} input image(s) found.`);
}

// Videos (a flat bucket) have an empty m.folder, so skip the leading "\" that would
// otherwise show up for them.
function matchDisplayPath(m) {
  return m.folder ? `${m.folder}\\${m.name}` : m.name;
}

function buildThumbCell(m, index) {
  const cell = document.createElement('div');
  cell.className = 'thumb' + (state.selectedIds.has(m.id) ? ' selected' : '');
  cell.dataset.id = m.id;

  if (m.isVideo) {
    if (m.thumbnailId) {
      // A same-named image next to the video (see videos/serve-videos.js) - a real <img> is a
      // far more reliable thumbnail than relying on the browser to decode a video frame.
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = '/api/image?id=' + encodeURIComponent(m.thumbnailId);
      img.alt = m.name;
      cell.appendChild(img);
    } else {
      const video = document.createElement('video');
      video.src = '/api/image?id=' + encodeURIComponent(m.id);
      video.muted = true;
      video.preload = 'metadata';
      video.playsInline = true;
      cell.appendChild(video);
    }

    const playBadge = document.createElement('div');
    playBadge.className = 'thumb-video-badge';
    playBadge.textContent = '▶';
    cell.appendChild(playBadge);
  } else if (m.isAudio || m.isText) {
    // No visual thumbnail to decode for archive/ items - just an icon standing in for the type.
    const icon = document.createElement('div');
    icon.className = 'thumb-file-icon';
    icon.textContent = m.isAudio ? '🎵' : '📄';
    cell.appendChild(icon);
  } else {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = '/api/image?id=' + encodeURIComponent(m.id);
    img.alt = m.name;
    cell.appendChild(img);
  }

  const check = document.createElement('div');
  check.className = 'thumb-check';
  check.textContent = '✓';
  cell.appendChild(check);

  const label = document.createElement('div');
  label.className = 'thumb-label' + (m.orphanReason ? ' thumb-label-orphan' : '');
  const prefix = m.orphanReason ? `[orphan: ${m.orphanReason}] ` : (m.promptIndex >= 0 ? `[${m.promptIndex}] ` : '');
  label.textContent = prefix + matchDisplayPath(m);
  cell.appendChild(label);

  cell.addEventListener('click', (ev) => onThumbClick(ev, index));
  cell.addEventListener('dblclick', () => openPreview(index));

  return cell;
}

// Groups matches by their full directory (top-level folder, plus any subfolder path - since
// scanning recurses into subfolders, m.name can be "sub/dir/photo.jpg") while keeping each
// match's real index into state.matches (needed so click handlers / the preview filmstrip -
// which walk state.matches directly - stay correct regardless of the on-screen grouping).
function groupMatchesByFolder() {
  const groups = new Map();
  state.matches.forEach((m, index) => {
    const slash = m.name.lastIndexOf('/');
    const subDir = slash === -1 ? '' : m.name.slice(0, slash);
    const key = subDir ? `${m.folder}/${subDir}` : m.folder;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ m, index });
  });
  // Sort the groups themselves alphabetically, independent of the current sort mode
  // (name/folder/prompt) - that mode still governs ordering *within* each group.
  return new Map(
    [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' })),
  );
}

function renderGrid() {
  const grid = el('grid');
  grid.innerHTML = '';

  const groups = groupMatchesByFolder();
  // A single group's worth of results doesn't need a section header repeating its own name.
  const showHeaders = groups.size > 1;

  for (const [groupKey, entries] of groups) {
    const isCollapsed = showHeaders && state.collapsedFolderGroups.has(groupKey);

    if (showHeaders) {
      const header = document.createElement('div');
      header.className = 'folder-group-header';

      const arrow = document.createElement('span');
      arrow.className = 'folder-group-arrow' + (isCollapsed ? ' collapsed' : '');
      arrow.textContent = '▾';
      header.appendChild(arrow);

      const title = document.createElement('span');
      title.textContent = `${groupKey} (${entries.length})`;
      header.appendChild(title);

      header.addEventListener('click', () => {
        if (state.collapsedFolderGroups.has(groupKey)) state.collapsedFolderGroups.delete(groupKey);
        else state.collapsedFolderGroups.add(groupKey);
        renderGrid();
      });
      grid.appendChild(header);
    }

    const subgrid = document.createElement('div');
    subgrid.className = 'thumb-grid' + (isCollapsed ? ' collapsed' : '');
    entries.forEach(({ m, index }) => subgrid.appendChild(buildThumbCell(m, index)));
    grid.appendChild(subgrid);
  }
}

// Updates only the .selected class on existing cells - deliberately does NOT rebuild the
// grid (renderGrid()/innerHTML='') on every click. Destroying and recreating the clicked
// element between the two clicks of a double-click is exactly what was making dblclick
// unreliable: by the time the browser dispatched dblclick, the element it fired on could
// already differ from the one the first click had removed.
function updateSelectionClasses() {
  for (const cell of el('grid').querySelectorAll('.thumb')) {
    cell.classList.toggle('selected', state.selectedIds.has(cell.dataset.id));
  }
}

// Click toggles this image into/out of the selection (checkbox-style, like Quick Select - no
// modifier key needed to multi-select). Shift-click extends a range from the last click.
function onThumbClick(ev, index) {
  const m = state.matches[index];
  if (ev.shiftKey && state.lastClickedIndex !== null) {
    const [a, b] = [state.lastClickedIndex, index].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) state.selectedIds.add(state.matches[i].id);
  } else if (state.selectedIds.has(m.id)) {
    state.selectedIds.delete(m.id);
  } else {
    state.selectedIds.add(m.id);
  }
  state.lastClickedIndex = index;
  updateSelectionClasses();
}

// ---------- Image viewer (full-viewport overlay) ----------

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 12;
const ZOOM_STEP = 1.15;
const FILMSTRIP_WINDOW = 12; // items shown on each side of the current one

const preview = {
  items: [],
  index: 0,
  kind: 'image', // 'image' | 'video' | 'audio' | 'text' - zoom/pan only apply to 'image'
  zoom: 1,
  panX: 0,
  panY: 0,
  dragging: false,
  dragMoved: false, // true once a drag has actually panned - suppresses the next click-to-close
  dragStartX: 0,
  dragStartY: 0,
  dragOrigPanX: 0,
  dragOrigPanY: 0,
};

function isViewerOpen() {
  return !el('viewer-overlay').classList.contains('hidden');
}

function openPreview(index) {
  preview.items = state.matches;
  preview.index = index;
  preview.zoom = 1;
  preview.panX = 0;
  preview.panY = 0;
  el('viewer-overlay').classList.remove('hidden');
  showPreviewImage();
  renderFilmstrip();
}

function closePreview() {
  el('viewer-overlay').classList.add('hidden');
  el('viewer-video').pause();
  el('viewer-audio').pause();
}

function applyTransform() {
  if (preview.kind !== 'image') return;
  el('viewer-image').style.transform = `translate(${preview.panX}px, ${preview.panY}px) scale(${preview.zoom})`;
  el('viewer-zoom-reset').textContent = Math.round(preview.zoom * 100) + '%';
  const wrap = el('viewer-image-wrap');
  wrap.classList.toggle('pannable', preview.zoom > 1);
}

function setZoom(newZoom) {
  if (preview.kind !== 'image') return;
  preview.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
  if (preview.zoom <= 1) { preview.panX = 0; preview.panY = 0; }
  applyTransform();
}

function showPreviewImage() {
  const m = preview.items[preview.index];
  if (!m) return;
  preview.kind = m.isVideo ? 'video' : m.isAudio ? 'audio' : m.isText ? 'text' : 'image';

  const img = el('viewer-image');
  const video = el('viewer-video');
  const audio = el('viewer-audio');
  const text = el('viewer-text');

  video.pause();
  video.removeAttribute('src');
  video.load();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  img.classList.toggle('hidden', preview.kind !== 'image');
  video.classList.toggle('hidden', preview.kind !== 'video');
  audio.classList.toggle('hidden', preview.kind !== 'audio');
  text.classList.toggle('hidden', preview.kind !== 'text');

  img.src = preview.kind === 'image' ? '/api/image?id=' + encodeURIComponent(m.id) : '';
  if (preview.kind === 'video') video.src = '/api/image?id=' + encodeURIComponent(m.id);
  if (preview.kind === 'audio') audio.src = '/api/image?id=' + encodeURIComponent(m.id);
  if (preview.kind === 'text') {
    text.textContent = 'Loading...';
    const myId = m.id;
    fetch('/api/image?id=' + encodeURIComponent(m.id))
      .then((res) => res.text())
      .then((content) => {
        if (preview.items[preview.index]?.id !== myId) return; // superseded by navigation
        text.textContent = content;
      })
      .catch((err) => {
        if (preview.items[preview.index]?.id !== myId) return;
        text.textContent = `Failed to load: ${err.message}`;
      });
  }

  // Only the zoom-specific buttons need images - viewer-close lives in the same container
  // and must stay visible regardless.
  const showZoom = preview.kind === 'image';
  el('viewer-zoom-out').classList.toggle('hidden', !showZoom);
  el('viewer-zoom-reset').classList.toggle('hidden', !showZoom);
  el('viewer-zoom-in').classList.toggle('hidden', !showZoom);
  el('viewer-image-wrap').classList.remove('pannable');
  applyTransform();
  el('viewer-title').textContent = `${matchDisplayPath(m)}  (${preview.index + 1}/${preview.items.length})`;
  const multi = preview.items.length > 1;
  el('viewer-arrow-left').classList.toggle('hidden', !multi);
  el('viewer-arrow-right').classList.toggle('hidden', !multi);
  highlightFilmstrip();
}

function previewGoTo(delta) {
  if (preview.items.length <= 1) return;
  preview.index = (preview.index + delta + preview.items.length) % preview.items.length;
  preview.zoom = 1;
  preview.panX = 0;
  preview.panY = 0;
  showPreviewImage();
}

function previewGoToIndex(index) {
  if (index === preview.index) return;
  preview.index = index;
  preview.zoom = 1;
  preview.panX = 0;
  preview.panY = 0;
  showPreviewImage();
}

// Bottom filmstrip: a window of thumbnails around the current image, so scrubbing
// through a huge grid doesn't render thousands of filmstrip cells at once.
function renderFilmstrip() {
  const strip = el('viewer-filmstrip');
  strip.innerHTML = '';
  strip.classList.toggle('hidden', preview.items.length <= 1);
  if (preview.items.length <= 1) return;

  const start = Math.max(0, preview.index - FILMSTRIP_WINDOW);
  const end = Math.min(preview.items.length - 1, preview.index + FILMSTRIP_WINDOW);
  for (let i = start; i <= end; i++) {
    const m = preview.items[i];
    const cell = document.createElement('div');
    cell.className = 'filmstrip-item' + (i === preview.index ? ' current' : '');
    cell.dataset.index = String(i);
    if (m.isVideo) {
      if (m.thumbnailId) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = '/api/image?id=' + encodeURIComponent(m.thumbnailId);
        img.alt = m.name;
        cell.appendChild(img);
      } else {
        const video = document.createElement('video');
        video.muted = true;
        video.preload = 'metadata';
        video.src = '/api/image?id=' + encodeURIComponent(m.id);
        cell.appendChild(video);
      }
    } else if (m.isAudio || m.isText) {
      const icon = document.createElement('div');
      icon.className = 'thumb-file-icon';
      icon.textContent = m.isAudio ? '🎵' : '📄';
      cell.appendChild(icon);
    } else {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = '/api/image?id=' + encodeURIComponent(m.id);
      img.alt = m.name;
      cell.appendChild(img);
    }
    cell.addEventListener('click', () => previewGoToIndex(i));
    strip.appendChild(cell);
  }
  highlightFilmstrip();
}

function highlightFilmstrip() {
  const strip = el('viewer-filmstrip');
  const cells = strip.querySelectorAll('.filmstrip-item');
  let needsRebuild = true;
  cells.forEach((cell) => {
    const isCurrent = Number(cell.dataset.index) === preview.index;
    cell.classList.toggle('current', isCurrent);
    if (isCurrent) { needsRebuild = false; cell.scrollIntoView({ inline: 'center', block: 'nearest' }); }
  });
  // Current index scrolled outside the rendered window - rebuild the strip centered on it.
  if (needsRebuild && cells.length > 0) renderFilmstrip();
}

el('viewer-arrow-left').addEventListener('click', () => previewGoTo(-1));
el('viewer-arrow-right').addEventListener('click', () => previewGoTo(1));
el('viewer-close').addEventListener('click', closePreview);

// Click outside the media (the empty backdrop around it, inside viewer-image-wrap) closes the
// viewer - only fires when the wrap itself is the click target, not the img/video/arrows.
// Panning a zoomed-in image can end a drag with the cursor over exposed background (the image
// moved out from under it), which would otherwise look identical to a genuine outside click -
// dragMoved suppresses that one click after a real pan.
el('viewer-image-wrap').addEventListener('click', (ev) => {
  if (preview.dragMoved) { preview.dragMoved = false; return; }
  if (ev.target === el('viewer-image-wrap')) closePreview();
});
el('viewer-zoom-in').addEventListener('click', () => setZoom(preview.zoom * ZOOM_STEP));
el('viewer-zoom-out').addEventListener('click', () => setZoom(preview.zoom / ZOOM_STEP));
el('viewer-zoom-reset').addEventListener('click', () => setZoom(1));

el('viewer-image-wrap').addEventListener('wheel', (ev) => {
  if (!isViewerOpen() || preview.kind !== 'image') return;
  ev.preventDefault();
  setZoom(preview.zoom * (ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
}, { passive: false });

// Drag-to-pan, only meaningful once zoomed in past the fitted size.
const viewerWrap = el('viewer-image-wrap');
viewerWrap.addEventListener('pointerdown', (ev) => {
  if (preview.zoom <= 1) return;
  preview.dragging = true;
  preview.dragMoved = false;
  preview.dragStartX = ev.clientX;
  preview.dragStartY = ev.clientY;
  preview.dragOrigPanX = preview.panX;
  preview.dragOrigPanY = preview.panY;
  viewerWrap.classList.add('panning');
  viewerWrap.setPointerCapture(ev.pointerId);
});
viewerWrap.addEventListener('pointermove', (ev) => {
  if (!preview.dragging) return;
  preview.dragMoved = true;
  preview.panX = preview.dragOrigPanX + (ev.clientX - preview.dragStartX);
  preview.panY = preview.dragOrigPanY + (ev.clientY - preview.dragStartY);
  applyTransform();
});
function endDrag(ev) {
  if (!preview.dragging) return;
  preview.dragging = false;
  viewerWrap.classList.remove('panning');
  try { viewerWrap.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
}
viewerWrap.addEventListener('pointerup', endDrag);
viewerWrap.addEventListener('pointercancel', endDrag);

document.addEventListener('keydown', (ev) => {
  if (!isViewerOpen()) return;
  if (!document.getElementById('modal-overlay').classList.contains('hidden')) return;
  if (!document.getElementById('hls-modal-overlay').classList.contains('hidden')) return;
  if (ev.key === 'Escape') closePreview();
  else if (ev.key === 'ArrowLeft') previewGoTo(-1);
  else if (ev.key === 'ArrowRight') previewGoTo(1);
  else if (ev.key === '+' || ev.key === '=') setZoom(preview.zoom * ZOOM_STEP);
  else if (ev.key === '-') setZoom(preview.zoom / ZOOM_STEP);
  else if (ev.key === '0') setZoom(1);
});

// ---------- Toolbar wiring ----------

el('btn-input-root').addEventListener('click', async () => {
  const { path } = await apiJson('/api/pick-folder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Choose the input root (raw source photos)' }),
  });
  if (!path) return;
  await saveConfigPatch({ inputRoot: path });
  state.selectedFolders.clear();
  exitVideosMode();
  exitArchiveMode();
  await loadInputFolders();
  await refreshMatches();
});

el('btn-output-root').addEventListener('click', async () => {
  const { path } = await apiJson('/api/pick-folder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Choose the output root (compressed/generated images "Find Outputs" searches)' }),
  });
  if (!path) return;
  await saveConfigPatch({ outputRoot: path });
  setStatus('Output root set to ' + path);
});

el('btn-prompt-file').addEventListener('click', async () => {
  const { path } = await apiJson('/api/pick-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Choose the prompt file', filter: 'Text Files (*.txt)|*.txt|All Files (*.*)|*.*' }),
  });
  if (!path) return;
  await saveConfigPatch({ promptFile: path });
  await loadPrompts();
});

el('btn-reload').addEventListener('click', async () => {
  await Promise.all([loadInputFolders(), loadPrompts()]);
  if (state.showVideos) await refreshVideos();
  else if (state.showArchive) await refreshArchive();
  else await refreshMatches();
});

// ---------- Find Outputs (Input folder(s)/image(s)/root + prompt(s) -> matching outputs) ----------

el('btn-find-outputs').addEventListener('click', async () => {
  if (state.selectedPromptIndices.size === 0 && !state.includeNonMatching) {
    alert('Select at least one prompt (or "Non-matching") first.');
    return;
  }

  // Specific images only count when the grid is currently showing Input (their ids only
  // decode meaningfully as Input-relative paths).
  const images = state.gridMode === 'input' ? [...state.selectedIds] : [];

  const params = new URLSearchParams();
  if (images.length > 0) params.set('images', images.join(','));
  if (state.searchAllFolders) {
    params.set('sourceFolders', '*');
  } else if (state.selectedFolders.size > 0) {
    params.set('sourceFolders', [...state.selectedFolders].join(','));
  } else if (images.length === 0) {
    alert('Pick Input folder(s), Input image(s), or select "All folders" first.');
    return;
  }
  if (state.selectedPromptIndices.size > 0) params.set('prompts', [...state.selectedPromptIndices].join(','));
  if (state.includeNonMatching) params.set('includeNonMatching', '1');
  params.set('sort', state.sortMode);

  setStatus('Finding matching outputs...');
  let results;
  try {
    results = await apiJson('/api/matches?' + params.toString());
  } catch (err) {
    setStatus('Error: ' + err.message);
    return;
  }
  state.matches = results;
  state.gridMode = 'outputs';
  state.selectedIds = new Set();
  renderGrid();
  setStatus(`${results.length} output image(s) found.`);
});

// ---------- Find Orphaned Outputs (Output images matching no current prompt/input image) ----------

el('btn-find-orphans').addEventListener('click', async () => {
  const params = new URLSearchParams();
  if (state.searchAllFolders) {
    params.set('sourceFolders', '*');
  } else if (state.selectedFolders.size > 0) {
    params.set('sourceFolders', [...state.selectedFolders].join(','));
  } else {
    alert('Pick Input folder(s), or select "All folders" first.');
    return;
  }

  setStatus('Finding orphaned outputs...');
  let results;
  try {
    results = await apiJson('/api/orphans?' + params.toString());
  } catch (err) {
    setStatus('Error: ' + err.message);
    return;
  }
  state.matches = results;
  state.gridMode = 'outputs';
  state.selectedIds = new Set();
  renderGrid();
  setStatus(`${results.length} orphaned output image(s) found (no matching current prompt or input image).`);
});

let searchDebounce = null;
el('search-box').addEventListener('input', (ev) => {
  state.searchText = ev.target.value;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(refreshMatches, 200);
});

el('sort-select').addEventListener('change', (ev) => {
  state.sortMode = ev.target.value;
  refreshMatches();
});

// ---------- Encrypt / Decrypt modal ----------

const modal = {
  mode: null, // 'encrypt' | 'decrypt'
};

function openModal(mode) {
  modal.mode = mode;
  el('modal-title').textContent = mode === 'encrypt' ? 'Encrypt Folder' : 'Decrypt Folder';
  el('modal-confirm-row').classList.toggle('hidden', mode !== 'encrypt');
  el('modal-source').value = '';
  el('modal-dest').value = '';
  el('modal-password').value = '';
  el('modal-confirm').value = '';
  el('modal-force').checked = false;
  el('modal-log').textContent = '';
  el('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  el('modal-overlay').classList.add('hidden');
}

el('btn-encrypt').addEventListener('click', () => openModal('encrypt'));
el('btn-decrypt').addEventListener('click', () => openModal('decrypt'));
el('modal-cancel').addEventListener('click', closeModal);

el('modal-pick-source').addEventListener('click', async () => {
  const { path } = await apiJson('/api/pick-folder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: modal.mode === 'encrypt' ? 'Choose the folder to encrypt' : 'Choose the encrypted folder' }),
  });
  if (path) el('modal-source').value = path;
});

el('modal-pick-dest').addEventListener('click', async () => {
  const { path } = await apiJson('/api/pick-folder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Choose the destination folder' }),
  });
  if (path) el('modal-dest').value = path;
});

// Shared by the Encrypt/Decrypt and Convert-HLS-to-MP4 modals: POST to a streaming endpoint
// (text/plain, chunked as the server-side process runs) and append each chunk to logEl live.
async function streamToLog(url, body, logEl) {
  logEl.textContent = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      logEl.textContent += decoder.decode(value, { stream: true });
      logEl.scrollTop = logEl.scrollHeight;
    }
  } catch (err) {
    logEl.textContent += `\nRequest failed: ${err.message}\n`;
  }
}

el('modal-start').addEventListener('click', async () => {
  const sourceDir = el('modal-source').value;
  const destDir = el('modal-dest').value;
  const password = el('modal-password').value;
  const confirmPassword = el('modal-confirm').value;
  const force = el('modal-force').checked;

  if (!sourceDir || !destDir) { alert('Pick both a source and destination folder.'); return; }
  if (!password) { alert('Enter a password.'); return; }
  if (modal.mode === 'encrypt' && password !== confirmPassword) { alert('Passwords do not match.'); return; }

  el('modal-start').disabled = true;
  await streamToLog(`/api/${modal.mode}`, { sourceDir, destDir, password, confirmPassword, force }, el('modal-log'));
  el('modal-start').disabled = false;
});

// ---------- Convert HLS to MP4 modal ----------

function setHlsInputMode(mode) {
  const isFile = mode === 'file';
  el('hls-mode-file').classList.toggle('active', isFile);
  el('hls-mode-paste').classList.toggle('active', !isFile);
  el('hls-file-row').classList.toggle('hidden', !isFile);
  el('hls-paste-row').classList.toggle('hidden', isFile);
}

function openHlsModal() {
  el('hls-input-path').value = '';
  el('hls-input-paste').value = '';
  setHlsInputMode('file');
  el('hls-dest-dir').value = state.config.videosRoot || '';
  el('hls-output-name').value = '';
  el('hls-parallel').value = '10';
  el('hls-log').textContent = '';
  el('hls-modal-overlay').classList.remove('hidden');
}

function closeHlsModal() {
  el('hls-modal-overlay').classList.add('hidden');
}

el('btn-hls-to-mp4').addEventListener('click', openHlsModal);
el('hls-cancel').addEventListener('click', closeHlsModal);
el('hls-mode-file').addEventListener('click', () => setHlsInputMode('file'));
el('hls-mode-paste').addEventListener('click', () => setHlsInputMode('paste'));

el('hls-pick-input').addEventListener('click', async () => {
  const { path } = await apiJson('/api/pick-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Choose the .m3u8 playlist', filter: 'M3U8 Playlist (*.m3u8)|*.m3u8|All Files (*.*)|*.*' }),
  });
  if (!path) return;
  el('hls-input-path').value = path;
  if (!el('hls-output-name').value) {
    const base = path.replace(/\\/g, '/').split('/').pop().replace(/\.m3u8$/i, '');
    el('hls-output-name').value = `${base}.mp4`;
  }
});

el('hls-pick-dest').addEventListener('click', async () => {
  const { path } = await apiJson('/api/pick-folder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Choose the destination folder for the mp4' }),
  });
  if (path) el('hls-dest-dir').value = path;
});

el('hls-start').addEventListener('click', async () => {
  const usingPaste = !el('hls-paste-row').classList.contains('hidden');
  const inputPath = el('hls-input-path').value;
  const inputContent = el('hls-input-paste').value;
  const destDir = el('hls-dest-dir').value;
  const outputName = el('hls-output-name').value.trim();
  const parallel = Number(el('hls-parallel').value);

  if (usingPaste ? !inputContent.trim() : !inputPath) {
    alert(usingPaste ? 'Paste the .m3u8 playlist content.' : 'Pick a .m3u8 playlist.');
    return;
  }
  if (!destDir) { alert('Pick a destination folder.'); return; }
  if (!outputName) { alert('Enter an output filename.'); return; }

  const body = { destDir, outputName, parallel };
  if (usingPaste) body.inputContent = inputContent;
  else body.inputPath = inputPath;

  el('hls-start').disabled = true;
  await streamToLog('/api/hls-to-mp4', body, el('hls-log'));
  el('hls-start').disabled = false;
});

// Enter runs "Find Outputs" from anywhere on the main page - the Encrypt-Decrypt and
// HLS-to-MP4 modals/the image viewer each handle their own Enter separately, so this stays
// out of their way.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  if (!el('modal-overlay').classList.contains('hidden')) return;
  if (!el('hls-modal-overlay').classList.contains('hidden')) return;
  if (isViewerOpen()) return;
  if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
  ev.preventDefault();
  el('btn-find-outputs').click();
});

// ---------- Boot ----------

(async function boot() {
  applySectionCollapse();
  renderVideosSection();
  renderArchiveSection();
  await loadConfig();
  await Promise.all([loadInputFolders(), loadPrompts()]);
  setStatus('Ready.');
})();
