import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadFile, downloadFile, storePat, loadManifest, saveManifest, createBlobsForFile, commitFilesToManifest } from "../src/githubStore.js";
import { encryptBuffer, decryptBuffer } from "../src/crypto.js";

const ADMIN_CONFIG = {
  token: "fake-token",
  owner: "fake-owner",
  repo: "fake-repo",
  keys: { admin: "admin-key", quantran: "quantran-key" },
};

const QUANTRAN_CONFIG = {
  token: "fake-token",
  owner: "fake-owner",
  repo: "fake-repo",
  keys: { quantran: "quantran-key" }, // no "admin" entry - can't touch admin's folder
};

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("uploadFile PUTs base64-encrypted content under blobs/<folder>/ and returns a SHA-pinned cdn_url", async (t) => {
  let capturedUrl, capturedInit;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({ commit: { sha: "abc123" } });
  });

  const result = await uploadFile({
    buffer: Buffer.from("hello world"),
    folder: "quantran",
    config: ADMIN_CONFIG,
  });

  assert.equal(capturedUrl, "https://api.github.com/repos/fake-owner/fake-repo/contents/" + result.path);
  assert.equal(capturedInit.method, "PUT");
  assert.equal(capturedInit.headers.Authorization, "Bearer fake-token");

  const body = JSON.parse(capturedInit.body);
  assert.match(body.content, /^[A-Za-z0-9+/]+=*$/); // valid base64
  // Commit messages sit unencrypted in a public repo - the real filename
  // must never end up in one, only inside the encrypted manifest entry.
  assert.doesNotMatch(body.message, /hello/i);

  assert.match(result.path, /^blobs\/quantran\/[0-9a-f-]{36}\.enc$/);
  assert.equal(result.commit_sha, "abc123");
  assert.equal(
    result.cdn_url,
    `https://cdn.jsdelivr.net/gh/fake-owner/fake-repo@abc123/${result.path}`
  );
});

test("uploadFile throws if the caller's config has no key for that folder", async () => {
  await assert.rejects(
    () => uploadFile({ buffer: Buffer.from("x"), folder: "admin", config: QUANTRAN_CONFIG }),
    /no encryption key configured for folder "admin"/
  );
});

test("uploadFile requires a folder", async () => {
  await assert.rejects(
    () => uploadFile({ buffer: Buffer.from("x"), config: ADMIN_CONFIG }),
    /folder is required/
  );
});

test("storePat (first time) checks for an existing sha, finds none, and creates pat.enc", async (t) => {
  let putUrl, putInit, getCalled = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (!init || init.method === undefined) {
      // getExistingSha's plain GET (no method specified defaults to GET)
      getCalled = true;
      return { ok: false, status: 404 };
    }
    putUrl = url;
    putInit = init;
    return jsonResponse({ commit: { sha: "def456" } });
  });

  const result = await storePat({ folder: "quantran", pat: "github_pat_realtoken", config: ADMIN_CONFIG });

  assert.equal(getCalled, true);
  assert.equal(putUrl, "https://api.github.com/repos/fake-owner/fake-repo/contents/blobs/quantran/pat.enc");
  assert.equal(result.path, "blobs/quantran/pat.enc");
  assert.equal(result.commit_sha, "def456");

  const body = JSON.parse(putInit.body);
  assert.equal(body.sha, undefined); // nothing to overwrite - no sha in the request
  const encrypted = Buffer.from(body.content, "base64");
  const decrypted = decryptBuffer(encrypted, ADMIN_CONFIG.keys.quantran);
  assert.equal(decrypted.toString("utf8"), "github_pat_realtoken");
});

test("storePat (rotating) includes the existing sha so GitHub allows the overwrite", async (t) => {
  let putInit;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (!init || init.method === undefined) {
      return jsonResponse({ sha: "existing-sha-123" }); // pat.enc already exists
    }
    putInit = init;
    return jsonResponse({ commit: { sha: "def789" } });
  });

  await storePat({ folder: "quantran", pat: "github_pat_rotated", config: ADMIN_CONFIG });

  const body = JSON.parse(putInit.body);
  assert.equal(body.sha, "existing-sha-123");
});

test("storePat throws if the caller's config has no key for that folder", async () => {
  await assert.rejects(
    () => storePat({ folder: "admin", pat: "x", config: QUANTRAN_CONFIG }),
    /no encryption key configured for folder "admin"/
  );
});

test("uploadFile throws with the response body on a non-ok GitHub response", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({ message: "Bad credentials" }, { ok: false, status: 401 })
  );

  await assert.rejects(
    () => uploadFile({ buffer: Buffer.from("x"), folder: "admin", config: ADMIN_CONFIG }),
    /github upload failed: 401/
  );
});

test("downloadFile fetches, decrypts using the folder parsed from the URL, and returns the original plaintext", async (t) => {
  const original = Buffer.from("the actual file bytes");
  const encrypted = encryptBuffer(original, ADMIN_CONFIG.keys.quantran);

  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => encrypted.buffer.slice(
      encrypted.byteOffset,
      encrypted.byteOffset + encrypted.byteLength
    ),
  }));

  const cdnUrl = "https://cdn.jsdelivr.net/gh/x/y@z/blobs/quantran/f.enc";
  const result = await downloadFile({ cdnUrl, config: ADMIN_CONFIG });
  assert.deepEqual(result, original);
});

test("downloadFile throws (never even fetches) when the config has no key for that folder", async (t) => {
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalled = true;
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  });

  const cdnUrl = "https://cdn.jsdelivr.net/gh/x/y@z/blobs/admin/f.enc";
  await assert.rejects(
    () => downloadFile({ cdnUrl, config: QUANTRAN_CONFIG }),
    /no encryption key configured for folder "admin"/
  );
  assert.equal(fetchCalled, false);
});

test("downloadFile throws on a cdn_url that doesn't look like a githost path", async () => {
  await assert.rejects(
    () => downloadFile({ cdnUrl: "https://example.com/not-a-githost-url", config: ADMIN_CONFIG }),
    /doesn't look like a githost path/
  );
});

test("downloadFile retries a 404 (jsDelivr not caught up yet) before succeeding", async (t) => {
  const original = Buffer.from("eventually available");
  const encrypted = encryptBuffer(original, ADMIN_CONFIG.keys.admin);
  let calls = 0;

  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => encrypted.buffer.slice(
        encrypted.byteOffset,
        encrypted.byteOffset + encrypted.byteLength
      ),
    };
  });

  const cdnUrl = "https://cdn.jsdelivr.net/gh/x/y@z/blobs/admin/f.enc";
  const result = await downloadFile({ cdnUrl, config: ADMIN_CONFIG });
  assert.deepEqual(result, original);
  assert.equal(calls, 3);
});

test("downloadFile gives up and throws after exhausting retries", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }));

  const cdnUrl = "https://cdn.jsdelivr.net/gh/x/y@z/blobs/admin/f.enc";
  await assert.rejects(
    () => downloadFile({ cdnUrl, config: ADMIN_CONFIG }),
    /jsdelivr fetch failed: 404/
  );
});

// ---- chunked upload/download -------------------------------------------

// In-memory fake of the GitHub Git Data API (blobs/trees/commits/refs) -
// what chunked/batch uploads now use instead of one Contents-API PUT per
// blob, so tests can exercise the real multi-request flow (parallel blob
// creation, then one tree+commit+ref-update) without a real network call.
function fakeGitData({ owner = "fake-owner", repo = "fake-repo", branch = "main" } = {}) {
  const blobs = new Map(); // sha -> base64 content
  const trees = new Map(); // sha -> Map(path -> blobSha), fully materialized (base_tree already merged in)
  const commits = new Map(); // sha -> { treeSha, parents }
  let blobCounter = 0;
  let treeCounter = 0;
  let commitCounter = 0;

  const initialTreeSha = "tree-0";
  trees.set(initialTreeSha, new Map());
  let headCommitSha = "commit-0";
  commits.set(headCommitSha, { treeSha: initialTreeSha, parents: [] });

  const calls = [];
  const prefix = `https://api.github.com/repos/${owner}/${repo}`;

  async function fetchImpl(url, init) {
    calls.push({ url: String(url), init });
    const u = String(url);
    const method = init?.method;

    if (u === prefix && !method) return jsonResponse({ default_branch: branch });
    if (u === `${prefix}/git/ref/heads/${branch}` && !method) return jsonResponse({ object: { sha: headCommitSha } });

    const commitMatch = u.match(/\/git\/commits\/([^/]+)$/);
    if (commitMatch && !method) {
      const c = commits.get(commitMatch[1]);
      if (!c) return { ok: false, status: 404, text: async () => "no such commit" };
      return jsonResponse({ tree: { sha: c.treeSha } });
    }
    if (u === `${prefix}/git/blobs` && method === "POST") {
      blobCounter += 1;
      const sha = `blob-${blobCounter}`;
      blobs.set(sha, JSON.parse(init.body).content);
      return jsonResponse({ sha });
    }
    if (u === `${prefix}/git/trees` && method === "POST") {
      const body = JSON.parse(init.body);
      const merged = new Map(trees.get(body.base_tree));
      for (const item of body.tree) merged.set(item.path, item.sha);
      treeCounter += 1;
      const sha = `tree-${treeCounter}`;
      trees.set(sha, merged);
      return jsonResponse({ sha });
    }
    if (u === `${prefix}/git/commits` && method === "POST") {
      const body = JSON.parse(init.body);
      commitCounter += 1;
      const sha = `commit-${commitCounter}`;
      commits.set(sha, { treeSha: body.tree, parents: body.parents });
      return jsonResponse({ sha });
    }
    if (u === `${prefix}/git/refs/heads/${branch}` && method === "PATCH") {
      headCommitSha = JSON.parse(init.body).sha;
      return jsonResponse({ object: { sha: headCommitSha } });
    }
    // Contents-API GET - loadManifest() still reads manifest.enc this way even
    // though writes now go through the Git Data API above; served by looking
    // the path up in the current HEAD tree.
    const contentsMatch = u.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/contents/(.+)$`));
    if (contentsMatch && !method) {
      const p = decodeURIComponent(contentsMatch[1]);
      const blobSha = currentTree().get(p);
      if (!blobSha) return { ok: false, status: 404 };
      return jsonResponse({ content: blobs.get(blobSha), sha: blobSha });
    }
    throw new Error(`fakeGitData: unhandled request ${method || "GET"} ${u}`);
  }

  function currentTree() {
    return trees.get(commits.get(headCommitSha).treeSha);
  }

  return { fetchImpl, blobs, calls, currentTree, commitCount: () => commitCounter };
}

test("uploadFile calls onChunkProgress once per chunk (blob created), ending at (chunkCount, chunkCount)", async (t) => {
  const original = Buffer.from("0123456789".repeat(10)); // 100 bytes
  const { fetchImpl } = fakeGitData();
  t.mock.method(globalThis, "fetch", fetchImpl);

  const calls = [];
  await uploadFile({
    buffer: original,
    folder: "quantran",
    config: ADMIN_CONFIG,
    chunkSize: 30, // -> 4 chunks
    onChunkProgress: (done, total) => calls.push([done, total]),
  });

  assert.equal(calls.length, 4);
  for (const [, total] of calls) assert.equal(total, 4);
  assert.deepEqual(new Set(calls.map(([done]) => done)), new Set([1, 2, 3, 4]));
});

test("uploadFile splits a buffer bigger than chunkSize into independently encrypted chunks committed together in ONE commit, and downloadFile reassembles them", async (t) => {
  const original = Buffer.from("0123456789".repeat(10)); // 100 bytes
  const fake = fakeGitData();
  t.mock.method(globalThis, "fetch", fake.fetchImpl);

  const result = await uploadFile({
    buffer: original,
    folder: "quantran",
    config: ADMIN_CONFIG,
    chunkSize: 30, // -> 4 chunks (30,30,30,10)
  });

  assert.equal(result.chunked, true);
  assert.equal(result.chunkCount, 4);
  assert.equal(fake.blobs.size, 4); // 4 chunk blobs created
  assert.equal(fake.commitCount(), 1); // but only ONE commit for all of them - the whole point of batching
  assert.equal(new Set(result.chunks.map((c) => c.commit_sha)).size, 1); // all chunks share that one commit

  const tree = fake.currentTree();
  for (const chunk of result.chunks) assert.ok(tree.has(chunk.path), `tree missing ${chunk.path}`);

  // Each chunk is independently encrypted (different IV -> different ciphertext even for equal-length chunks).
  const ciphertexts = result.chunks.map((c) => fake.blobs.get(tree.get(c.path)));
  assert.equal(new Set(ciphertexts).size, ciphertexts.length);

  t.mock.method(globalThis, "fetch", async (url) => {
    const path = String(url).replace(/^.*@[^/]+\//, "");
    const blobSha = tree.get(path);
    assert.ok(blobSha, `no stored chunk for ${path}`);
    const bytes = Buffer.from(fake.blobs.get(blobSha), "base64");
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  });

  const roundTripped = await downloadFile({
    cdnUrls: result.chunks.map((c) => c.cdn_url),
    config: ADMIN_CONFIG,
  });
  assert.deepEqual(roundTripped, original);
});

test("downloadFile(cdnUrls) throws on an empty array", async () => {
  await assert.rejects(() => downloadFile({ cdnUrls: [], config: ADMIN_CONFIG }), /cdnUrls is empty/);
});

// ---- batch upload (createBlobsForFile + commitFilesToManifest) ---------
// The path src/cli.js's upload-folder actually uses: blobs for many files
// are created independently, then committed - and the manifest updated -
// together in ONE commit, instead of one commit per file.

test("createBlobsForFile creates one blob for a small file, or one per chunk for a big one - either way, commits nothing", async (t) => {
  const fake = fakeGitData();
  t.mock.method(globalThis, "fetch", fake.fetchImpl);

  const small = await createBlobsForFile({ buffer: Buffer.from("small file"), folder: "quantran", config: ADMIN_CONFIG });
  assert.equal(small.chunked, false);
  assert.equal(small.blobEntries.length, 1);

  const big = await createBlobsForFile({ buffer: Buffer.from("x".repeat(100)), folder: "quantran", config: ADMIN_CONFIG, chunkSize: 30 });
  assert.equal(big.chunked, true);
  assert.equal(big.blobEntries.length, 4);

  assert.equal(fake.commitCount(), 0); // blob creation alone never commits
  assert.equal(fake.blobs.size, 5); // 1 (small) + 4 (big's chunks)
});

test("commitFilesToManifest commits several files' blobs AND the manifest update together in ONE commit", async (t) => {
  const fake = fakeGitData();
  t.mock.method(globalThis, "fetch", fake.fetchImpl);

  const fileA = await createBlobsForFile({ buffer: Buffer.from("file a"), folder: "quantran", config: ADMIN_CONFIG });
  const fileB = await createBlobsForFile({ buffer: Buffer.from("file b"), folder: "quantran", config: ADMIN_CONFIG });
  assert.equal(fake.commitCount(), 0); // still nothing committed yet

  const now = new Date().toISOString();
  const { commit_sha } = await commitFilesToManifest({
    folder: "quantran",
    blobEntries: [...fileA.blobEntries, ...fileB.blobEntries],
    newManifestEntries: [
      { id: fileA.id, name: "a.txt", type: "text/plain", size: 6, uploadedAt: now },
      { id: fileB.id, name: "b.txt", type: "text/plain", size: 6, uploadedAt: now },
    ],
    message: "store: 2 file(s)",
    config: ADMIN_CONFIG,
  });

  assert.equal(fake.commitCount(), 1); // 2 files + manifest, all in one commit
  assert.ok(commit_sha);

  const tree = fake.currentTree();
  assert.ok(tree.has(fileA.blobEntries[0].path));
  assert.ok(tree.has(fileB.blobEntries[0].path));
  assert.ok(tree.has("blobs/quantran/manifest.enc"));

  const { entries } = await loadManifest({ folder: "quantran", config: ADMIN_CONFIG });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.name).sort(), ["a.txt", "b.txt"]);
});

test("commitFilesToManifest called twice appends to the existing manifest rather than overwriting it", async (t) => {
  const fake = fakeGitData();
  t.mock.method(globalThis, "fetch", fake.fetchImpl);

  const fileA = await createBlobsForFile({ buffer: Buffer.from("file a"), folder: "quantran", config: ADMIN_CONFIG });
  await commitFilesToManifest({
    folder: "quantran",
    blobEntries: fileA.blobEntries,
    newManifestEntries: [{ id: fileA.id, name: "a.txt", type: "text/plain", size: 6, uploadedAt: new Date().toISOString() }],
    message: "store: 1 file(s)",
    config: ADMIN_CONFIG,
  });

  const fileB = await createBlobsForFile({ buffer: Buffer.from("file b"), folder: "quantran", config: ADMIN_CONFIG });
  await commitFilesToManifest({
    folder: "quantran",
    blobEntries: fileB.blobEntries,
    newManifestEntries: [{ id: fileB.id, name: "b.txt", type: "text/plain", size: 6, uploadedAt: new Date().toISOString() }],
    message: "store: 1 file(s)",
    config: ADMIN_CONFIG,
  });

  assert.equal(fake.commitCount(), 2);
  const { entries } = await loadManifest({ folder: "quantran", config: ADMIN_CONFIG });
  assert.deepEqual(entries.map((e) => e.name).sort(), ["a.txt", "b.txt"]);
});

// ---- manifest read/write (shared format with docs/app.js) --------------

test("loadManifest returns an empty manifest when none exists yet", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }));
  const result = await loadManifest({ folder: "quantran", config: ADMIN_CONFIG });
  assert.deepEqual(result, { entries: [], sha: null });
});

test("saveManifest then loadManifest round-trips the entries array", async (t) => {
  let stored;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (!init || init.method === undefined) {
      if (!stored) return { ok: false, status: 404 };
      return jsonResponse({ content: stored.content, sha: stored.sha });
    }
    const body = JSON.parse(init.body);
    stored = { content: body.content, sha: "manifest-sha-1" };
    return jsonResponse({ commit: { sha: "commit-1" }, content: { sha: "manifest-sha-1" } });
  });

  const entries = [{ id: "abc", name: "output/x/img.png", type: "image/png", size: 10, uploadedAt: "2026-01-01T00:00:00.000Z" }];
  const saveResult = await saveManifest({ folder: "quantran", entries, sha: null, config: ADMIN_CONFIG });
  assert.equal(saveResult.sha, "manifest-sha-1");

  const { entries: loaded, sha } = await loadManifest({ folder: "quantran", config: ADMIN_CONFIG });
  assert.deepEqual(loaded, entries);
  assert.equal(sha, "manifest-sha-1");
});
