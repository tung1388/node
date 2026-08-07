#!/usr/bin/env node
'use strict';

// Local web app replacing image_sorter.exe (the Win32/C GUI) - same matching logic as
// sort.js/lib.js (SHA-1(prompt) first 8 hex chars embedded in generated filenames as
// "..._HASH__..." or "...__HASH__..."), same folder-crypt-lib.js encrypt/decrypt, but
// as a Node HTTP server + browser frontend instead of a native window. Pure Node
// built-ins only - no npm install needed. Thumbnails are the browser's job (it decodes
// images itself), which is why there's no thumbnail-generation code here at all.
//
// Usage: node server.js [--port=5173] [--no-open]

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { encryptFolder, decryptFolder } = require('../folder-crypt-lib');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const REPO_ROOT = path.join(__dirname, '..');
const HLS_SCRIPT = path.join(REPO_ROOT, 'videos', 'hls_to_mp4.sh');

const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.mp3']);
const TEXT_EXTENSIONS = new Set(['.txt']);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const ARCHIVE_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...TEXT_EXTENSIONS]);
const MIME_BY_EXT = {
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
};

// ---------- Config (persisted next to server.js, defaults mirror sort.js/image_sorter.exe) ----------

function defaultConfig() {
  return {
    inputRoot: path.join(REPO_ROOT, 'input'),
    outputRoot: path.join(REPO_ROOT, 'compressed'),
    videosRoot: path.join(REPO_ROOT, 'videos'),
    archiveRoot: path.join(REPO_ROOT, 'archive'),
    promptFile: path.join(REPO_ROOT, 'prompt.txt'),
  };
}

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const merged = { ...defaultConfig(), ...saved };
    for (const key of ['inputRoot', 'outputRoot', 'videosRoot', 'archiveRoot', 'promptFile']) {
      merged[key] = path.resolve(__dirname, merged[key]);
    }
    return merged;
  } catch {
    return defaultConfig();
  }
}

function rootDir(root) {
  if (root === 'input') return config.inputRoot;
  if (root === 'output') return config.outputRoot;
  if (root === 'videos') return config.videosRoot;
  if (root === 'archive') return config.archiveRoot;
  return null;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ---------- Matching logic (mirrors sort.js / lib.js) ----------

function promptHash(promptText) {
  return crypto.createHash('sha1').update(promptText, 'utf8').digest('hex').slice(0, 8);
}

// Mirrors lib.js's sanitizeFilename()/imageDirName() - the naming scheme createJobs.js used
// to build each output filename's prefix, so we can find outputs for one specific input image.
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function imageDirName(imageFile) {
  const normalized = imageFile.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const stem = sanitizeFilename(path.parse(parts[parts.length - 1]).name);
  if (parts.length === 1) return stem;
  const dirPart = parts.slice(0, -1).map(sanitizeFilename).join('__');
  return `${dirPart}__${stem}`;
}

// Which prompt (if any, out of every current prompt - not just a picked subset) a filename's
// hash matches. -1 means it doesn't match any current prompt at all ("non-matching").
function matchPromptIndex(name, allPrompts) {
  const lower = name.toLowerCase();
  const found = allPrompts.find((p) => lower.includes(`_${p.hash}__`) || lower.includes(`__${p.hash}__`));
  return found ? found.index : -1;
}

function naturalSort(list, keyFn = (x) => x) {
  return list.sort((a, b) => keyFn(a).localeCompare(keyFn(b), undefined, { numeric: true, sensitivity: 'base' }));
}

async function listFolders(root) {
  let entries;
  try {
    entries = await fsp.readdir(rootDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  return naturalSort(names);
}

// Dot-folders (hidden/system) are still browsable/selectable individually via listFolders(),
// but never swept in by a "*"/"all folders" expansion - this is only used at those call sites.
function nonHiddenFolders(names) {
  return names.filter((name) => !name.startsWith('.'));
}

async function listPrompts() {
  let text;
  try {
    text = await fsp.readFile(config.promptFile, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.map((text, index) => ({ index, text, hash: promptHash(text) }));
}

const ID_SEP = ' ';

function encodeId(root, relPath) {
  return Buffer.from(`${root}${ID_SEP}${relPath}`, 'utf8').toString('base64url');
}

function decodeId(id) {
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  const sep = decoded.indexOf(ID_SEP);
  if (sep === -1) throw new Error('Malformed id');
  return { root: decoded.slice(0, sep), relPath: decoded.slice(sep + 1) };
}

// Scans one folder, recursing into subfolders. promptFilter is either null (browse mode -
// every image, promptIndex -1) or a list of {index, hash}.
async function scanFolder(root, folderName, promptFilter) {
  const folderPath = path.join(rootDir(root), folderName);
  const results = [];
  // videos/serve-videos.js generates <base>.jpg next to <base>.mp4 as a preview thumbnail -
  // only meaningful for the videos root, where such an image is the video's thumbnail rather
  // than its own separate item.
  const pairThumbnails = root === 'videos';
  // archive/ holds .mp3/.txt, not images/videos - every other root keeps the original set.
  const allowedExtensions = root === 'archive' ? ARCHIVE_EXTENSIONS : MEDIA_EXTENSIONS;

  async function walk(dir, subPath) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // First pass: collect this directory's own media files (recursing into subdirectories
    // immediately) so thumbnail pairing below can see every file in the directory at once.
    const mediaEntries = [];
    for (const entry of entries) {
      const entrySubPath = subPath ? `${subPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), entrySubPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;
      mediaEntries.push({ name: entry.name, ext, entrySubPath });
    }

    const videoBaseNames = pairThumbnails
      ? new Set(mediaEntries.filter((e) => VIDEO_EXTENSIONS.has(e.ext)).map((e) => path.parse(e.name).name.toLowerCase()))
      : null;

    for (const entry of mediaEntries) {
      const isVideo = VIDEO_EXTENSIONS.has(entry.ext);
      const baseName = path.parse(entry.name).name.toLowerCase();
      // A same-named image sitting next to a video is that video's thumbnail, not its own item.
      if (pairThumbnails && !isVideo && videoBaseNames.has(baseName)) continue;

      const lower = entry.name.toLowerCase();
      let promptIndex = -1;
      if (promptFilter && promptFilter.length > 0) {
        const found = promptFilter.find((p) => lower.includes(`_${p.hash}__`) || lower.includes(`__${p.hash}__`));
        if (!found) continue;
        promptIndex = found.index;
      }

      const relPath = path.posix.join(folderName, entry.entrySubPath);
      let stat;
      try {
        stat = await fsp.stat(path.join(dir, entry.name));
      } catch {
        continue;
      }

      let thumbnailId = null;
      if (pairThumbnails && isVideo) {
        const thumbEntry = mediaEntries.find(
          (e) => !VIDEO_EXTENSIONS.has(e.ext) && path.parse(e.name).name.toLowerCase() === baseName,
        );
        if (thumbEntry) thumbnailId = encodeId(root, path.posix.join(folderName, thumbEntry.entrySubPath));
      }

      results.push({
        id: encodeId(root, relPath), name: entry.entrySubPath, folder: folderName, promptIndex,
        size: stat.size, isVideo, thumbnailId,
        isAudio: AUDIO_EXTENSIONS.has(entry.ext), isText: TEXT_EXTENSIONS.has(entry.ext),
      });
    }
  }

  await walk(folderPath, '');
  return results;
}

// ---------- Native folder/file picker via PowerShell (no npm dependency) ----------

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => {
      if (err && err.code !== 1) return reject(err); // non-zero from Cancel is fine
      resolve(stdout.trim());
    });
  });
}

async function pickFolder(title) {
  const safeTitle = title.replace(/[`"$]/g, '');
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = "${safeTitle}"
$f.ShowNewFolderButton = $true
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }
`;
  const out = await runPowerShell(script);
  return out || null;
}

async function pickFile(title, filter) {
  const safeTitle = title.replace(/[`"$]/g, '');
  const safeFilter = (filter || 'All Files (*.*)|*.*').replace(/[`"$]/g, '');
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Title = "${safeTitle}"
$f.Filter = "${safeFilter}"
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }
`;
  const out = await runPowerShell(script);
  return out || null;
}

// ---------- HTTP plumbing ----------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(path.resolve(PUBLIC_DIR) + path.sep) && full !== path.resolve(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const mime = MIME_BY_EXT[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(full).pipe(res);
  });
}

function streamCryptOp(req, res, mode) {
  readJsonBody(req)
    .then(async (body) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      const onLog = (line) => { try { res.write(line + '\n'); } catch { /* client gone */ } };
      try {
        if (mode === 'encrypt') {
          if (body.password !== body.confirmPassword) throw new Error('Passwords did not match.');
          await encryptFolder({
            sourceDir: body.sourceDir, destDir: body.destDir, password: body.password,
            force: !!body.force, onLog,
          });
        } else {
          await decryptFolder({
            sourceDir: body.sourceDir, destDir: body.destDir, password: body.password,
            force: !!body.force, onLog,
          });
        }
      } catch (err) {
        onLog(`ERROR: ${err.message}`);
      } finally {
        res.end();
      }
    })
    .catch((err) => {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Bad request: ${err.message}`);
    });
}

// Runs videos/hls_to_mp4.sh (bash script - segments/retries/PNG-header stripping/ffmpeg remux
// all live there) as a child process, streaming its stdout/stderr to the client live, same
// shape of response as streamCryptOp above.
function streamHlsToMp4(req, res) {
  readJsonBody(req)
    .then(async (body) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      const onLog = (line) => { try { res.write(line + '\n'); } catch { /* client gone */ } };

      const destDir = body.destDir;
      const outputName = body.outputName;
      const parallel = Number(body.parallel);

      if (!destDir || !outputName) {
        onLog('ERROR: Destination folder and output filename are required.');
        return res.end();
      }
      if (!body.inputPath && !body.inputContent) {
        onLog('ERROR: Pick a playlist file or paste its content.');
        return res.end();
      }

      // Pasted content has no file of its own yet - stash it under the OS temp dir first so
      // the script (which reads INPUT as a local file) has something to point at.
      let inputPath = body.inputPath;
      let tempInputPath = null;
      if (!inputPath) {
        tempInputPath = path.join(os.tmpdir(), `hls-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.m3u8`);
        await fsp.writeFile(tempInputPath, body.inputContent, 'utf8');
        inputPath = tempInputPath;
      }

      const outputPath = path.join(destDir, outputName);
      const args = [HLS_SCRIPT, inputPath, outputPath];
      if (Number.isInteger(parallel) && parallel > 0) args.push(String(parallel));

      const cleanup = async () => {
        if (!tempInputPath) return;
        try { await fsp.unlink(tempInputPath); } catch { /* best effort */ }
      };

      const child = spawn('bash', args, { windowsHide: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => onLog(chunk.replace(/\n$/, '')));
      child.stderr.on('data', (chunk) => onLog(chunk.replace(/\n$/, '')));
      child.on('error', async (err) => { onLog(`ERROR: ${err.message}`); await cleanup(); res.end(); });
      child.on('close', async (code) => {
        onLog(code === 0 ? 'Done.' : `Exited with code ${code}.`);
        await cleanup();
        res.end();
      });
    })
    .catch((err) => {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Bad request: ${err.message}`);
    });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  (async () => {
    try {
      if (pathname === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, config);
      }
      if (pathname === '/api/config' && req.method === 'POST') {
        const body = await readJsonBody(req);
        config = { ...config, ...body };
        saveConfig(config);
        return sendJson(res, 200, config);
      }
      if (pathname === '/api/pick-folder' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const picked = await pickFolder(body.title || 'Choose a folder');
        return sendJson(res, 200, { path: picked });
      }
      if (pathname === '/api/pick-file' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const picked = await pickFile(body.title || 'Choose a file', body.filter);
        return sendJson(res, 200, { path: picked });
      }
      if (pathname === '/api/folders' && req.method === 'GET') {
        const root = url.searchParams.get('root');
        if (!rootDir(root)) return sendJson(res, 400, { error: 'root must be "input" or "output"' });
        const folders = await listFolders(root);
        return sendJson(res, 200, folders.map((name, index) => ({ index, name })));
      }
      if (pathname === '/api/prompts' && req.method === 'GET') {
        return sendJson(res, 200, await listPrompts());
      }
      if (pathname === '/api/matches' && req.method === 'GET') {
        const imagesParam = url.searchParams.get('images'); // specific input-image ids
        const sourceFoldersParam = url.searchParams.get('sourceFolders'); // input folder names, or "*"
        const promptsParam = url.searchParams.get('prompts') || '';
        const includeNonMatching = url.searchParams.get('includeNonMatching') === '1';
        const search = (url.searchParams.get('search') || '').toLowerCase();
        const sortMode = url.searchParams.get('sort') || 'name';

        const allPrompts = await listPrompts();
        const wantedIndices = promptsParam ? promptsParam.split(',').map(Number).filter((n) => !Number.isNaN(n)) : [];
        const promptFilter = wantedIndices.length > 0 ? wantedIndices.map((i) => allPrompts[i]).filter(Boolean) : null;

        let root, folders, imagePrefixesByFolder = null;
        if (imagesParam || sourceFoldersParam) {
          // "Find outputs": Input folder(s) and/or specific Input image(s) (+ optionally "all
          // folders") -> the same-named Output folder(s). A folder with specific image(s) picked
          // is narrowed to just those images' outputs (filtered by filename prefix, see lib.js's
          // pairFilePrefix); a folder picked with no individual images is taken in full.
          root = 'output';
          imagePrefixesByFolder = new Map(); // folder -> [prefix, ...]
          if (imagesParam) {
            for (const id of imagesParam.split(',').filter(Boolean)) {
              let relPath;
              try { ({ relPath } = decodeId(id)); } catch { return sendJson(res, 400, { error: 'Bad image id' }); }
              const folder = path.posix.dirname(relPath.replace(/\\/g, '/'));
              if (!imagePrefixesByFolder.has(folder)) imagePrefixesByFolder.set(folder, []);
              imagePrefixesByFolder.get(folder).push(imageDirName(relPath).toLowerCase() + '__');
            }
          }

          const folderSet = new Set();
          if (sourceFoldersParam === '*') for (const f of nonHiddenFolders(await listFolders('input'))) folderSet.add(f);
          else if (sourceFoldersParam) for (const f of sourceFoldersParam.split(',').filter(Boolean)) folderSet.add(f);
          for (const folder of imagePrefixesByFolder.keys()) folderSet.add(folder);
          folders = [...folderSet];
          if (folders.length === 0) return sendJson(res, 200, []);
        } else {
          root = url.searchParams.get('root');
          if (!rootDir(root)) return sendJson(res, 400, { error: 'root must be "input", "output", "videos", or "archive"' });
          if (root === 'videos' || root === 'archive') {
            // videos/ and archive/ are flat buckets - no folder picker needed, always scan the
            // root itself (scanFolder still recurses if subfolders do turn up).
            folders = [''];
          } else {
            // Plain browsing (this branch) shows hidden folders' contents same as any other -
            // only the Find Outputs "sourceFolders=*" expansion above excludes them.
            const folderParam = url.searchParams.get('folder') || '';
            if (folderParam === '*') folders = await listFolders(root);
            else if (folderParam) folders = folderParam.split(',').filter(Boolean);
            else return sendJson(res, 200, []);
          }
        }

        // "Non-matching" (an item matching none of the current prompts at all) can't be
        // expressed as a hash to filter by inside scanFolder, so when it's requested we scan
        // unfiltered instead and do the prompt inclusion check ourselves below.
        const wantedIndexSet = new Set(wantedIndices);
        const perFolder = await Promise.all(folders.map(async (f) => {
          const folderResults = await scanFolder(root, f, includeNonMatching ? null : promptFilter);
          const prefixes = imagePrefixesByFolder && imagePrefixesByFolder.get(f);
          const imageFiltered = prefixes
            ? folderResults.filter((m) => prefixes.some((p) => m.name.toLowerCase().startsWith(p)))
            : folderResults; // no specific images picked for this folder - take it whole

          if (!includeNonMatching) return imageFiltered;
          return imageFiltered
            .map((m) => ({ ...m, promptIndex: matchPromptIndex(m.name, allPrompts) }))
            .filter((m) => wantedIndexSet.has(m.promptIndex) || m.promptIndex === -1);
        }));
        let results = perFolder.flat();

        if (search) results = results.filter((m) => m.name.toLowerCase().includes(search));

        const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        if (sortMode === 'folder') results.sort((a, b) => cmp(a.folder, b.folder) || cmp(a.name, b.name));
        else if (sortMode === 'prompt') results.sort((a, b) => a.promptIndex - b.promptIndex || cmp(a.name, b.name));
        else results.sort((a, b) => cmp(a.name, b.name));

        return sendJson(res, 200, results);
      }
      if (pathname === '/api/orphans' && req.method === 'GET') {
        // Output images that no longer correspond to anything current: their filename's
        // prompt-hash doesn't match any prompt in prompt.txt anymore, and/or their filename's
        // image prefix (see lib.js's imageDirName) doesn't match any image still sitting in
        // the same-named Input folder. Checked against *every* current prompt, not a picked
        // subset - this is an audit of the whole folder, not a Find Outputs-style lookup.
        const sourceFoldersParam = url.searchParams.get('sourceFolders') || '*';
        const folderSet = new Set();
        if (sourceFoldersParam === '*') for (const f of nonHiddenFolders(await listFolders('input'))) folderSet.add(f);
        else for (const f of sourceFoldersParam.split(',').filter(Boolean)) folderSet.add(f);
        const folders = [...folderSet];
        if (folders.length === 0) return sendJson(res, 200, []);

        const validHashes = (await listPrompts()).map((p) => p.hash);

        const perFolder = await Promise.all(folders.map(async (folder) => {
          const [inputImages, outputImages] = await Promise.all([
            scanFolder('input', folder, null),
            scanFolder('output', folder, null),
          ]);
          const validPrefixes = inputImages.map(
            (m) => imageDirName(path.posix.join(folder, m.name)).toLowerCase() + '__',
          );

          const orphans = [];
          for (const m of outputImages) {
            const lower = m.name.toLowerCase();
            const hashOk = validHashes.some((h) => lower.includes(`_${h}__`) || lower.includes(`__${h}__`));
            const imageOk = validPrefixes.some((p) => lower.startsWith(p));
            if (hashOk && imageOk) continue;
            const orphanReason = !hashOk && !imageOk ? 'no matching prompt or input image'
              : !hashOk ? 'no matching prompt' : 'no matching input image';
            orphans.push({ ...m, orphanReason });
          }
          return orphans;
        }));

        const results = perFolder.flat();
        const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        results.sort((a, b) => cmp(a.folder, b.folder) || cmp(a.name, b.name));
        return sendJson(res, 200, results);
      }
      if (pathname === '/api/image' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        let root, relPath;
        try { ({ root, relPath } = decodeId(id)); } catch { res.writeHead(400); return res.end(); }
        if (!rootDir(root)) { res.writeHead(400); return res.end(); }
        const resolvedRoot = path.resolve(rootDir(root));
        const fullPath = path.resolve(resolvedRoot, relPath);
        if (fullPath !== resolvedRoot && !fullPath.startsWith(resolvedRoot + path.sep)) {
          res.writeHead(403); return res.end();
        }
        fs.stat(fullPath, (err, stat) => {
          if (err || !stat.isFile()) { res.writeHead(404); return res.end(); }
          const mime = MIME_BY_EXT[path.extname(fullPath).toLowerCase()] || 'application/octet-stream';

          // Range support (same as videos/serve-videos.js) - lets <video> seek/scrub without
          // downloading the whole file first. Images ignore the Range header, same as before.
          const range = req.headers.range;
          if (range) {
            const [startStr, endStr] = range.replace(/^bytes=/, '').split('-');
            const start = parseInt(startStr, 10) || 0;
            const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': end - start + 1,
              'Content-Type': mime,
              'Cache-Control': 'no-cache',
            });
            fs.createReadStream(fullPath, { start, end }).pipe(res);
            return;
          }

          res.writeHead(200, {
            'Content-Type': mime, 'Content-Length': stat.size,
            'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache',
          });
          fs.createReadStream(fullPath).pipe(res);
        });
        return;
      }
      if (pathname === '/api/encrypt' && req.method === 'POST') return streamCryptOp(req, res, 'encrypt');
      if (pathname === '/api/decrypt' && req.method === 'POST') return streamCryptOp(req, res, 'decrypt');
      if (pathname === '/api/hls-to-mp4' && req.method === 'POST') return streamHlsToMp4(req, res);

      if (req.method === 'GET') return serveStatic(req, res, pathname);

      res.writeHead(404); res.end('Not found');
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  })();
});

const port = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 5173;
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Image Sorter web app running at ${url}`);
  if (!process.argv.includes('--no-open')) {
    execFile('cmd.exe', ['/c', 'start', '', url]);
  }
});
