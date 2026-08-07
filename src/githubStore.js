// =====================================================================
// src/githubStore.js
// ---------------------------------------------------------------------
// Encrypted static-file storage using a public GitHub repo as the blob
// store and jsDelivr as the free CDN in front of it.
//
// IMPORTANT: jsDelivr's /gh/ mode serves files committed into the git
// tree - NOT GitHub Release assets. That caps practical file size at
// git's own limit (~100MB hard block without Git LFS, and jsDelivr
// can't read LFS-tracked content anyway). Files over CHUNK_SIZE are
// split into independently-encrypted chunks (see system.md §3) at
// `blobs/<folder>/<id>/<index>.enc` instead of one `blobs/<folder>/<id>.enc`.
//
// cdn_url is always pinned to the exact commit SHA, not a branch name,
// so jsDelivr treats it as immutable content and serves it without the
// ~24h cache lag branch-based URLs get.
//
// Per-folder keys: config.keys is a { folderName: keyString } map, not a
// single global key. Each file lives under blobs/<folder>/<uuid>.enc and
// is encrypted with that folder's key. "Admin sees everything" just means
// admin's own config.keys contains every folder's key; a friend's config
// only ever contains their own folder's key, so their client can encrypt/
// decrypt within their own folder and nothing else - it could still fetch
// (but not decrypt) other folders' ciphertext, since the repo is public.
// Confidentiality here comes entirely from key possession, not from any
// network-level access control.
// =====================================================================

import { randomUUID } from "crypto";
import { encryptBuffer, decryptBuffer, splitIntoChunks, CHUNK_SIZE } from "./crypto.js";

const GITHUB_API = "https://api.github.com";
const JSDELIVR_RETRY_DELAYS_MS = [500, 1000, 2000]; // brand-new commits can take a moment to appear
const CHUNK_UPLOAD_CONCURRENCY = 4;

// Runs `worker` over `items` with at most `limit` in flight at once -
// no dependency needed for a pool this small. Exported so callers (e.g.
// src/cli.js's upload-folder) can parallelize across whole files, not
// just chunks within one file.
export async function runWithConcurrency(items, limit, worker) {
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

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keyForFolder(config, folder) {
  const key = config.keys?.[folder];
  if (!key) {
    throw new Error(`no encryption key configured for folder "${folder}"`);
  }
  return key;
}

/** Current sha for `path`, or undefined if it doesn't exist yet - needed to overwrite an existing path (GitHub rejects a PUT to an existing path with no sha). This is the blob's content sha (Contents API), NOT a commit sha - it can't be used to build a cdn_url, only as the `sha` field on an overwriting PUT. */
async function getExistingSha({ path, config }) {
  const { token, owner, repo } = config;
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    headers: githubHeaders(token),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`github get failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.sha;
}

const COMMIT_CONFLICT_RETRY_DELAYS_MS = [300, 600, 1200, 2000, 3000];

// Batch commits (commitBatchNow) get a much longer retry budget than a
// single Contents-API write: they're infrequent (once per COMMIT_BATCH_SIZE
// files, not once per file), so a long ceiling costs nothing on the happy
// path, but they're exactly the case most exposed to a genuinely busy
// shared repo - another CLI run, a browser session uploading at the same
// time, or (as observed in practice) this same folder being written from
// two places at once. ~2 minutes cumulative gives real contention time to
// clear instead of surfacing a failure a determined manual retry would've
// resolved anyway. Jitter avoids two colliding writers retrying in lockstep.
const BATCH_COMMIT_RETRY_DELAYS_MS = [300, 600, 1200, 2000, 3000, 4000, 6000, 8000, 10000, 15000, 20000, 30000];
function withJitter(ms) {
  return ms + Math.floor(Math.random() * ms * 0.3);
}

// The Contents API's commits are inherently serialized per-repo: each PUT
// creates a new commit with the branch's current HEAD as its sole parent,
// then fast-forwards the branch ref - only one commit can land at a time,
// no matter how many PUTs (even to completely unrelated paths) are in
// flight at once. Retrying a 409 works for a HANDFUL of concurrent
// writers, but the odds of winning any given round drop as concurrency
// rises, and a fixed retry budget eventually runs out - exactly what
// happened at higher upload-folder concurrency. Rather than fight that
// with more retries, actual writes are funneled through this one-at-a-
// time queue; only the prep work before a write (reading a file,
// encrypting it) benefits from a caller's concurrency setting, which is
// still a real win - the next write in line can fire the instant the
// previous one's response lands, with its bytes already ready.
let writeQueue = Promise.resolve();
function enqueueWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {}); // keep the queue alive even if this write ultimately fails
  return run;
}

/**
 * Shared PUT-encrypted-content-at-a-path core, used by uploadFile (random
 * path, always new) and storePat/saveManifest (fixed path, may already
 * exist). The actual HTTP call is queued (see enqueueWrite above); the
 * retry loop here is a safety net for the rarer case of a genuinely
 * external writer (another process, a browser session) landing a commit
 * in between, not the primary defense against concurrency.
 */
async function putEncrypted({ encrypted, path, message, config, sha }) {
  return enqueueWrite(() => putEncryptedNow({ encrypted, path, message, config, sha }));
}

async function putEncryptedNow({ encrypted, path, message, config, sha }) {
  const { token, owner, repo } = config;
  let lastError;
  for (let attempt = 0; attempt <= COMMIT_CONFLICT_RETRY_DELAYS_MS.length; attempt += 1) {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "PUT",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          content: encrypted.toString("base64"),
          ...(sha ? { sha } : {}),
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const commitSha = data.commit?.sha;
      if (!commitSha) {
        throw new Error("github upload failed: no commit sha in response");
      }
      return {
        path,
        commit_sha: commitSha,
        content_sha: data.content?.sha, // needed as the `sha` on a later overwriting PUT (optimistic concurrency) - distinct from commit_sha
        cdn_url: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${commitSha}/${path}`,
      };
    }

    const body = await res.text().catch(() => "");
    lastError = new Error(`github upload failed: ${res.status} ${body.slice(0, 300)}`);
    if (res.status !== 409 || attempt === COMMIT_CONFLICT_RETRY_DELAYS_MS.length) throw lastError;
    await sleep(COMMIT_CONFLICT_RETRY_DELAYS_MS[attempt]);
  }
  throw lastError;
}

// ---------------------------------------------------------------------
// Git Data API primitives - used for chunked/batch uploads instead of
// one Contents-API PUT (=one commit) per blob. Blob creation touches no
// ref and has zero commit contention, so it can run at full caller
// concurrency; only the final tree+commit+ref-update step needs the
// one-at-a-time queue, and there's exactly one of those per BATCH of
// blobs rather than one per blob. This is what makes upload-folder fast
// at real concurrency instead of bottlenecked on serialized commits.
// ---------------------------------------------------------------------

/** Creates a git blob (raw content, not yet reachable from any commit) - no ref/commit involved, so many can run concurrently with zero contention. */
async function createBlob({ encrypted, config }) {
  const { token, owner, repo } = config;
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs`, {
    method: "POST",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ content: encrypted.toString("base64"), encoding: "base64" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`github blob create failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.sha;
}

const branchCache = new Map(); // "owner/repo" -> default_branch, doesn't change mid-run
async function getDefaultBranch(config) {
  const { token, owner, repo } = config;
  const key = `${owner}/${repo}`;
  if (branchCache.has(key)) return branchCache.get(key);
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers: githubHeaders(token) });
  if (!res.ok) throw new Error(`github repo lookup failed: ${res.status}`);
  const { default_branch } = await res.json();
  branchCache.set(key, default_branch);
  return default_branch;
}

/**
 * Commits many already-created blobs in ONE commit: read current HEAD ->
 * build a new tree on top of it (base_tree + new entries) -> create a
 * commit -> fast-forward the branch ref. Queued (enqueueWrite) since the
 * ref-update step is still a single per-repo point of contention, but
 * that's now the ONLY serialized step per batch, not per file/chunk.
 *
 * `buildEntries()` is called fresh on every retry attempt (not just
 * once) so a caller whose entries depend on other freshly-read state
 * (src/cli.js's upload-folder re-reads the manifest here) stays correct
 * even if an external writer's commit landed in between - re-invoking
 * naturally re-reads that state instead of committing stale data on top
 * of a new parent.
 *
 * Returns `{ commit_sha }`; combine with each entry's own `path` (which
 * the caller already knows - it chose them) to build cdn_urls.
 */
async function commitBatch({ buildEntries, message, config }) {
  return enqueueWrite(() => commitBatchNow({ buildEntries, message, config }));
}

async function commitBatchNow({ buildEntries, message, config }) {
  const { token, owner, repo } = config;
  const branch = await getDefaultBranch(config);
  let lastError;
  for (let attempt = 0; attempt <= BATCH_COMMIT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const refRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`, { headers: githubHeaders(token) });
      if (!refRes.ok) throw Object.assign(new Error(`github ref lookup failed: ${refRes.status}`), { status: refRes.status });
      const refData = await refRes.json();
      const parentSha = refData.object.sha;

      const parentCommitRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits/${parentSha}`, { headers: githubHeaders(token) });
      if (!parentCommitRes.ok) throw Object.assign(new Error(`github commit lookup failed: ${parentCommitRes.status}`), { status: parentCommitRes.status });
      const { tree: { sha: baseTreeSha } } = await parentCommitRes.json();

      const entries = await buildEntries();

      const treeRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.blobSha })),
        }),
      });
      if (!treeRes.ok) {
        const body = await treeRes.text().catch(() => "");
        throw Object.assign(new Error(`github tree create failed: ${treeRes.status} ${body.slice(0, 300)}`), { status: treeRes.status });
      }
      const { sha: newTreeSha } = await treeRes.json();

      const commitRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ message, tree: newTreeSha, parents: [parentSha] }),
      });
      if (!commitRes.ok) {
        const body = await commitRes.text().catch(() => "");
        throw Object.assign(new Error(`github commit create failed: ${commitRes.status} ${body.slice(0, 300)}`), { status: commitRes.status });
      }
      const { sha: newCommitSha } = await commitRes.json();

      const updateRefRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        method: "PATCH",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ sha: newCommitSha }),
      });
      if (!updateRefRes.ok) {
        const body = await updateRefRes.text().catch(() => "");
        // Non-fast-forward (422) is this endpoint's version of the same "someone else
        // committed first" race a Contents-API PUT reports as 409 - treated identically below.
        throw Object.assign(new Error(`github ref update failed: ${updateRefRes.status} ${body.slice(0, 300)}`), { status: updateRefRes.status });
      }

      return { commit_sha: newCommitSha };
    } catch (err) {
      lastError = err;
      const isConflict = err.status === 409 || err.status === 422;
      if (!isConflict || attempt === BATCH_COMMIT_RETRY_DELAYS_MS.length) throw lastError;
      await sleep(withJitter(BATCH_COMMIT_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

function cdnUrlFor(config, commitSha, path) {
  return `https://cdn.jsdelivr.net/gh/${config.owner}/${config.repo}@${commitSha}/${path}`;
}

/**
 * Encrypt `buffer` with `folder`'s key and commit it to the configured
 * GitHub repo.
 *
 * The stored filename is a random UUID, deliberately unrelated to the
 * real filename or the file's content - the repo has to be public for
 * jsDelivr to read it at all, so nothing about what's stored (name,
 * type, whether two uploads share content) should be visible from the
 * repo listing or commit history beyond "this folder has N files." The
 * real filename never appears anywhere unencrypted - not in the path,
 * not in the commit message - only inside the encrypted manifest entry.
 *
 * Files at or under CHUNK_SIZE upload as a single blob via the Contents
 * API (one HTTP call already does blob+tree+commit+ref together - there's
 * no batching win to be had for just one blob) and return { chunked:
 * false, path, commit_sha, cdn_url }. Bigger files split into
 * independently AES-GCM-encrypted chunks (own random IV each - never
 * encrypt-then-slice): each chunk's blob is created concurrently (no
 * commit contention at that stage), then all of them land together in
 * ONE commit via the Git Data API - a 400MB file at CHUNK_SIZE is ~20+
 * chunks but only 1 commit, not 20. Returns { chunked: true, chunkCount,
 * chunks: [{path, commit_sha, cdn_url}, ...] } in chunk-index order.
 *
 * `chunkSize` defaults to CHUNK_SIZE - overridable so tests can exercise
 * chunking without moving megabytes of bytes around.
 *
 * `onChunkProgress(completedCount, totalCount)`, if given, fires after
 * each chunk's blob is created - the only way to see progress on a
 * single big chunked file, since the commit itself only happens once at
 * the very end.
 */
export async function uploadFile({ buffer, folder, config, id = randomUUID(), chunkSize = CHUNK_SIZE, onChunkProgress }) {
  if (!folder) throw new Error("folder is required");
  const key = keyForFolder(config, folder);

  if (buffer.length <= chunkSize) {
    const encrypted = encryptBuffer(buffer, key);
    return {
      chunked: false,
      id,
      ...(await putEncrypted({
        encrypted,
        path: `blobs/${folder}/${id}.enc`,
        message: "store: blob", // never the real filename - commit messages sit unencrypted in a public repo
        config,
      })),
    };
  }

  const chunks = splitIntoChunks(buffer, chunkSize);
  let completed = 0;
  const paths = chunks.map((_, index) => `blobs/${folder}/${id}/${index}.enc`);
  const blobShas = await runWithConcurrency(chunks, CHUNK_UPLOAD_CONCURRENCY, async (chunk) => {
    const encrypted = encryptBuffer(chunk, key);
    const sha = await createBlob({ encrypted, config });
    onChunkProgress?.(++completed, chunks.length);
    return sha;
  });

  const entries = paths.map((path, index) => ({ path, blobSha: blobShas[index] }));
  const { commit_sha } = await commitBatch({
    buildEntries: () => entries, // fixed - chunk blobs don't depend on any other state, safe to reuse across retries
    message: `store: blob (${chunks.length} chunks)`,
    config,
  });

  return {
    chunked: true, id, chunkCount: chunks.length,
    chunks: paths.map((path) => ({ path, commit_sha, cdn_url: cdnUrlFor(config, commit_sha, path) })),
  };
}

/**
 * Batches many already-uploaded-elsewhere files' worth of blobs into ONE
 * commit that ALSO updates the manifest - src/cli.js's upload-folder is
 * the intended caller: it creates every file's blob(s) concurrently
 * (createBlobsForFile below), then hands the resulting {path, blobSha}
 * entries here in batches so N files cost 1 commit instead of N.
 *
 * The manifest is re-read fresh inside the retry loop (via buildEntries)
 * so a concurrent external write to it (another process, a browser
 * session) doesn't get silently clobbered even under a genuine conflict.
 */
export async function commitFilesToManifest({ folder, blobEntries, newManifestEntries, message, config }) {
  const { commit_sha } = await commitBatch({
    message,
    config,
    buildEntries: async () => {
      const { entries } = await loadManifest({ folder, config });
      const mergedEntries = [...entries, ...newManifestEntries];
      const manifestBytes = Buffer.from(JSON.stringify(mergedEntries), "utf8");
      const manifestEncrypted = encryptBuffer(manifestBytes, keyForFolder(config, folder));
      const manifestBlobSha = await createBlob({ encrypted: manifestEncrypted, config });
      return [...blobEntries, { path: `blobs/${folder}/manifest.enc`, blobSha: manifestBlobSha }];
    },
  });
  return { commit_sha };
}

/** Creates every blob a single file needs (one if small, one per chunk if not) without committing anything - the caller batches these across files via commitFilesToManifest. Mirrors uploadFile()'s chunking decision exactly. */
export async function createBlobsForFile({ buffer, folder, config, id = randomUUID(), chunkSize = CHUNK_SIZE }) {
  const key = keyForFolder(config, folder);
  if (buffer.length <= chunkSize) {
    const encrypted = encryptBuffer(buffer, key);
    const sha = await createBlob({ encrypted, config });
    return { id, chunked: false, blobEntries: [{ path: `blobs/${folder}/${id}.enc`, blobSha: sha }] };
  }
  const chunks = splitIntoChunks(buffer, chunkSize);
  const blobShas = await runWithConcurrency(chunks, CHUNK_UPLOAD_CONCURRENCY, (chunk) => createBlob({ encrypted: encryptBuffer(chunk, key), config }));
  const blobEntries = blobShas.map((sha, index) => ({ path: `blobs/${folder}/${id}/${index}.enc`, blobSha: sha }));
  return { id, chunked: true, chunkCount: chunks.length, blobEntries };
}

/**
 * Admin-only: encrypt a friend's real GitHub PAT with their folder's key
 * and store it at a FIXED path (blobs/<folder>/pat.enc), so their web
 * frontend can bootstrap login from just folder+key (see docs/app.js) -
 * fetched unauthenticated via GitHub's public-repo API, since a friend
 * doesn't have a token yet at that point.
 *
 * SECURITY NOTE: this stores a real, live, write-scoped credential
 * (encrypted) in the same public repo whose confidentiality depends on
 * that folder's key. A leaked/guessed key for that folder now exposes a
 * working GitHub token with write access to the WHOLE repo, not just
 * that folder - not a new exposure in kind (the PAT already sits
 * unencrypted in that friend's browser localStorage after first login
 * today), but the encryption key itself now needs the same care as a
 * password, not just "protects my files."
 *
 * Safe to re-run: fetches the current sha (if pat.enc already exists) so
 * this both creates it the first time and rotates it on later calls,
 * rather than only ever working once.
 */
export async function storePat({ folder, pat, config }) {
  if (!folder) throw new Error("folder is required");
  if (!pat) throw new Error("pat is required");
  const path = `blobs/${folder}/pat.enc`;
  const encrypted = encryptBuffer(Buffer.from(pat, "utf8"), keyForFolder(config, folder));
  const sha = await getExistingSha({ path, config });
  return putEncrypted({ encrypted, path, message: `store pat for ${folder}`, config, sha });
}

/**
 * Reads blobs/<folder>/manifest.enc - the same encrypted JSON-array index
 * docs/app.js's loadManifest() maintains, so entries the Node CLI adds
 * here show up in the browser app and vice versa. Returns { entries: [],
 * sha: null } if no manifest exists yet (first upload to this folder).
 */
export async function loadManifest({ folder, config }) {
  const { token, owner, repo } = config;
  const path = `blobs/${folder}/manifest.enc`;
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    headers: githubHeaders(token),
  });
  if (res.status === 404) return { entries: [], sha: null };
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`github get failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const encrypted = Buffer.from(data.content, "base64");
  const decrypted = decryptBuffer(encrypted, keyForFolder(config, folder));
  return { entries: JSON.parse(decrypted.toString("utf8")), sha: data.sha };
}

/**
 * Writes `entries` back to blobs/<folder>/manifest.enc. Pass the `sha`
 * loadManifest() last returned - GitHub rejects the write (409) if the
 * manifest moved on since then, same optimistic-concurrency pattern as
 * storePat's rotation path.
 */
export async function saveManifest({ folder, entries, sha, config }) {
  const encrypted = encryptBuffer(Buffer.from(JSON.stringify(entries), "utf8"), keyForFolder(config, folder));
  const result = await putEncrypted({
    encrypted,
    path: `blobs/${folder}/manifest.enc`,
    message: `update manifest (${entries.length} files)`,
    config,
    sha,
  });
  return { ...result, sha: result.content_sha }; // `sha` is what the next saveManifest call needs to pass back in
}

// Pulls "quantran" out of ".../blobs/quantran/<uuid>.enc" (single blob) or
// ".../blobs/quantran/<uuid>/<index>.enc" (chunk) so downloadFile can look
// up the right key without the caller having to pass it in separately -
// the folder is already encoded in the URL uploadFile made.
function folderFromCdnUrl(cdnUrl) {
  const match = String(cdnUrl).match(/\/blobs\/([^/]+)\/[^/]+(?:\/[^/]+)?\.enc$/);
  if (!match) throw new Error(`cdn_url doesn't look like a githost path: ${cdnUrl}`);
  return match[1];
}

async function fetchAndDecryptOne(cdnUrl, key) {
  let lastError;
  for (let attempt = 0; attempt <= JSDELIVR_RETRY_DELAYS_MS.length; attempt += 1) {
    const res = await fetch(cdnUrl);
    if (res.ok) {
      const encrypted = Buffer.from(await res.arrayBuffer());
      return decryptBuffer(encrypted, key);
    }
    lastError = new Error(`jsdelivr fetch failed: ${res.status}`);
    if (attempt < JSDELIVR_RETRY_DELAYS_MS.length) {
      await sleep(JSDELIVR_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

/**
 * Fetch + decrypt a file previously stored via uploadFile(). The caller's
 * config must contain the key for whichever folder the URL(s) belong to -
 * if it doesn't (e.g. a friend's client trying to decrypt someone else's
 * folder), this throws rather than silently failing.
 *
 * jsDelivr fetching a just-created commit can lag by a moment, so each
 * fetch is retried a few times before giving up - this is NOT a general-
 * purpose retry for network failures, just for "the CDN hasn't caught up
 * yet" (a 404 immediately after upload).
 *
 * Pass `cdnUrl` for a file uploadFile() returned as `chunked: false`, or
 * `cdnUrls` (the chunk-index-ordered array of each chunk's own cdn_url)
 * for one it returned as `chunked: true` - chunks are fetched in
 * parallel but reassembled in order.
 */
export async function downloadFile({ cdnUrl, cdnUrls, config }) {
  if (cdnUrls) {
    if (cdnUrls.length === 0) throw new Error("cdnUrls is empty");
    const key = keyForFolder(config, folderFromCdnUrl(cdnUrls[0]));
    const parts = await Promise.all(cdnUrls.map((url) => fetchAndDecryptOne(url, key)));
    return Buffer.concat(parts);
  }
  const key = keyForFolder(config, folderFromCdnUrl(cdnUrl));
  return fetchAndDecryptOne(cdnUrl, key);
}
