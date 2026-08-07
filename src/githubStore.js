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

/** The default branch's current HEAD commit sha - used to build a valid cdn_url for a chunk that resume found already sitting in the repo (its own commit sha isn't known to us, but HEAD's tree contains it by definition since it already exists). */
async function getHeadCommitSha(config) {
  const { token, owner, repo } = config;
  const repoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers: githubHeaders(token) });
  if (!repoRes.ok) throw new Error(`github repo lookup failed: ${repoRes.status}`);
  const { default_branch } = await repoRes.json();
  const branchRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/${default_branch}`, {
    headers: githubHeaders(token),
  });
  if (!branchRes.ok) throw new Error(`github head commit lookup failed: ${branchRes.status}`);
  const { sha } = await branchRes.json();
  return sha;
}

const COMMIT_CONFLICT_RETRY_DELAYS_MS = [300, 600, 1200, 2000, 3000];

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

/**
 * Encrypt `buffer` with `folder`'s key and commit it to the configured
 * GitHub repo via the Contents API (a plain HTTPS PUT - no local git
 * binary needed).
 *
 * The stored filename is a random UUID, deliberately unrelated to the
 * real filename or the file's content - the repo has to be public for
 * jsDelivr to read it at all, so nothing about what's stored (name,
 * type, whether two uploads share content) should be visible from the
 * repo listing or commit history beyond "this folder has N files." The
 * real filename never appears anywhere unencrypted - not in the path,
 * not in the commit message - only inside the encrypted manifest entry.
 *
 * Files at or under CHUNK_SIZE upload as a single blob and return
 * { chunked: false, path, commit_sha, cdn_url } (unchanged shape from
 * before chunking existed). Bigger files split into independently
 * AES-GCM-encrypted chunks (own random IV each - never encrypt-then-
 * slice) at `blobs/<folder>/<id>/<index>.enc`, uploaded with limited
 * concurrency, and return { chunked: true, chunkCount, chunks: [{path,
 * commit_sha, cdn_url}, ...] } in chunk-index order. Chunk paths are
 * deterministic per `id`, so re-running uploadFile with the same `id`
 * skips chunks that already exist (resume) instead of re-uploading them.
 *
 * `chunkSize` defaults to CHUNK_SIZE - overridable so tests can exercise
 * chunking without moving 64MB of bytes around.
 *
 * `onChunkProgress(completedCount, totalCount)`, if given, fires after
 * each chunk finishes (upload or resume-skip) - the only way to see
 * progress on a single big chunked file, since chunks upload with
 * limited concurrency and the whole call otherwise only resolves once.
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
  let headCommitSha; // lazily fetched, at most once, only if resume finds an already-uploaded chunk
  let completed = 0;
  const results = await runWithConcurrency(chunks, CHUNK_UPLOAD_CONCURRENCY, async (chunk, index) => {
    const path = `blobs/${folder}/${id}/${index}.enc`;
    const existingSha = await getExistingSha({ path, config });
    if (existingSha) {
      headCommitSha ??= await getHeadCommitSha(config);
      onChunkProgress?.(++completed, chunks.length);
      return {
        path,
        commit_sha: headCommitSha,
        cdn_url: `https://cdn.jsdelivr.net/gh/${config.owner}/${config.repo}@${headCommitSha}/${path}`,
      };
    }
    const encrypted = encryptBuffer(chunk, key);
    const result = await putEncrypted({ encrypted, path, message: `store: blob chunk ${index}/${chunks.length}`, config });
    onChunkProgress?.(++completed, chunks.length);
    return result;
  });

  return { chunked: true, id, chunkCount: chunks.length, chunks: results };
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
