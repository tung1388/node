const API = "https://api.github.com";

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getBlobBytes({ owner, repo, sha, authHeaders }) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/blobs/${sha}`, { headers: authHeaders });
  if (!res.ok) throw new Error(`github blob fetch failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return base64ToBytes(data.content);
}

/** Returns { bytes, sha } for an existing file, or null if the path doesn't exist. */
export async function getFile({ owner, repo, token, path }) {
  const authHeaders = headers(token);
  const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}`, { headers: authHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github get failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const meta = await res.json();
  return { bytes: await getBlobBytes({ owner, repo, sha: meta.sha, authHeaders }), sha: meta.sha };
}

/**
 * Same as getFile(), but with no Authorization header - used exactly
 * once, at login, before the app has a real token yet: GitHub allows
 * unauthenticated reads of PUBLIC repo contents (just at a much lower
 * rate limit - ~60 req/hour per IP - which is fine for an occasional
 * login, not something to use for regular file operations).
 */
export async function getPublicFile({ owner, repo, path }) {
  const authHeaders = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}`, { headers: authHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github get failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const meta = await res.json();
  return { bytes: await getBlobBytes({ owner, repo, sha: meta.sha, authHeaders }), sha: meta.sha };
}

const COMMIT_CONFLICT_RETRY_DELAYS_MS = [300, 600, 1200, 2000, 3000];

// The Contents API's commits are inherently serialized per-repo: each PUT
// creates a new commit with the branch's current HEAD as its sole parent,
// then fast-forwards the branch ref - only one commit can land at a time,
// no matter how many PUTs (even to completely unrelated paths) are in
// flight at once. Actual writes are funneled through this one-at-a-time
// queue so a chunked upload's concurrency (see docs/app.js) doesn't spend
// itself racing against its own other chunks - only the prep work before
// a write (encrypting a chunk) benefits from that concurrency.
let writeQueue = Promise.resolve();
function enqueueWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {}); // keep the queue alive even if this write ultimately fails
  return run;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates or updates a file. Pass `sha` (from a prior getFile()) when
 * overwriting an existing path - GitHub requires it as a concurrency
 * check, rejecting the write if the file has moved on since you read it.
 */
export async function putFile({ owner, repo, token, path, bytes, message, sha }) {
  return enqueueWrite(() => putFileNow({ owner, repo, token, path, bytes, message, sha }));
}

async function putFileNow({ owner, repo, token, path, bytes, message, sha }) {
  let lastError;
  for (let attempt = 0; attempt <= COMMIT_CONFLICT_RETRY_DELAYS_MS.length; attempt += 1) {
    const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
      method: "PUT",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: bytesToBase64(bytes),
        ...(sha ? { sha } : {}),
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return { sha: data.content.sha, commit_sha: data.commit.sha };
    }
    const body = await res.text().catch(() => "");
    lastError = new Error(`github put failed: ${res.status} ${body.slice(0, 300)}`);
    if (res.status !== 409 || attempt === COMMIT_CONFLICT_RETRY_DELAYS_MS.length) throw lastError;
    await sleep(COMMIT_CONFLICT_RETRY_DELAYS_MS[attempt]);
  }
  throw lastError;
}
