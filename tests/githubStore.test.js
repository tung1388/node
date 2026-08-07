import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadFile, downloadFile, storePat, loadManifest, saveManifest } from "../src/githubStore.js";
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
    fileName: "hello.txt",
    folder: "quantran",
    config: ADMIN_CONFIG,
  });

  assert.equal(capturedUrl, "https://api.github.com/repos/fake-owner/fake-repo/contents/" + result.path);
  assert.equal(capturedInit.method, "PUT");
  assert.equal(capturedInit.headers.Authorization, "Bearer fake-token");

  const body = JSON.parse(capturedInit.body);
  assert.match(body.content, /^[A-Za-z0-9+/]+=*$/); // valid base64
  assert.match(body.message, /hello\.txt/);

  assert.match(result.path, /^blobs\/quantran\/[0-9a-f-]{36}\.enc$/);
  assert.equal(result.commit_sha, "abc123");
  assert.equal(
    result.cdn_url,
    `https://cdn.jsdelivr.net/gh/fake-owner/fake-repo@abc123/${result.path}`
  );
});

test("uploadFile throws if the caller's config has no key for that folder", async () => {
  await assert.rejects(
    () => uploadFile({ buffer: Buffer.from("x"), fileName: "x.txt", folder: "admin", config: QUANTRAN_CONFIG }),
    /no encryption key configured for folder "admin"/
  );
});

test("uploadFile requires a folder", async () => {
  await assert.rejects(
    () => uploadFile({ buffer: Buffer.from("x"), fileName: "x.txt", config: ADMIN_CONFIG }),
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
    () => uploadFile({ buffer: Buffer.from("x"), fileName: "x.txt", folder: "admin", config: ADMIN_CONFIG }),
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

// In-memory fake of the GitHub Contents API, keyed by path, so chunked
// tests can exercise real multi-request flows (GET-then-PUT per chunk,
// resume skipping) without a 64MB buffer or a real network call.
function fakeGithub({ existingPaths = new Set(), headCommitSha = "head-sha" } = {}) {
  const store = new Map(); // path -> { content (base64), commitSha }
  let commitCounter = 0;
  const calls = [];

  async function fetchImpl(url, init) {
    calls.push({ url, init });
    const path = decodeURIComponent(String(url).replace("https://api.github.com/repos/fake-owner/fake-repo/contents/", ""));

    if (!init || init.method === undefined) {
      // repo/default-branch lookups used by getHeadCommitSha
      if (String(url) === "https://api.github.com/repos/fake-owner/fake-repo") {
        return jsonResponse({ default_branch: "main" });
      }
      if (String(url) === "https://api.github.com/repos/fake-owner/fake-repo/commits/main") {
        return jsonResponse({ sha: headCommitSha });
      }
      // getExistingSha
      if (existingPaths.has(path) || store.has(path)) {
        return jsonResponse({ sha: `blobsha-${path}` });
      }
      return { ok: false, status: 404 };
    }

    // PUT
    commitCounter += 1;
    const body = JSON.parse(init.body);
    store.set(path, { content: body.content, commitSha: `commit-${commitCounter}` });
    return jsonResponse({ commit: { sha: `commit-${commitCounter}` } });
  }

  return { fetchImpl, store, calls };
}

test("uploadFile calls onChunkProgress once per chunk, ending at (chunkCount, chunkCount)", async (t) => {
  const original = Buffer.from("0123456789".repeat(10)); // 100 bytes
  const { fetchImpl } = fakeGithub();
  t.mock.method(globalThis, "fetch", fetchImpl);

  const calls = [];
  await uploadFile({
    buffer: original,
    fileName: "big.bin",
    folder: "quantran",
    config: ADMIN_CONFIG,
    chunkSize: 30, // -> 4 chunks
    onChunkProgress: (done, total) => calls.push([done, total]),
  });

  assert.equal(calls.length, 4);
  for (const [, total] of calls) assert.equal(total, 4);
  assert.deepEqual(new Set(calls.map(([done]) => done)), new Set([1, 2, 3, 4]));
});

test("uploadFile splits a buffer bigger than chunkSize into independently encrypted chunks, and downloadFile reassembles them", async (t) => {
  const original = Buffer.from("0123456789".repeat(10)); // 100 bytes
  const { fetchImpl, store } = fakeGithub();
  t.mock.method(globalThis, "fetch", fetchImpl);

  const result = await uploadFile({
    buffer: original,
    fileName: "big.bin",
    folder: "quantran",
    config: ADMIN_CONFIG,
    chunkSize: 30, // -> 4 chunks (30,30,30,10)
  });

  assert.equal(result.chunked, true);
  assert.equal(result.chunkCount, 4);
  assert.equal(store.size, 4);

  // Each chunk is independently encrypted (different IV -> different ciphertext even for equal-length chunks).
  const ciphertexts = result.chunks.map((c) => store.get(c.path).content);
  assert.equal(new Set(ciphertexts).size, ciphertexts.length);

  t.mock.method(globalThis, "fetch", async (url) => {
    const path = String(url).replace(/^.*@[^/]+\//, "");
    const entry = [...store.entries()].find(([p]) => p === path);
    assert.ok(entry, `no stored chunk for ${path}`);
    const bytes = Buffer.from(entry[1].content, "base64");
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  });

  const roundTripped = await downloadFile({
    cdnUrls: result.chunks.map((c) => c.cdn_url),
    config: ADMIN_CONFIG,
  });
  assert.deepEqual(roundTripped, original);
});

test("uploadFile resume: chunks that already exist are skipped (no PUT) and still produce a valid cdn_url", async (t) => {
  const original = Buffer.from("A".repeat(50));
  // Chunk 0 (bytes 0-19) already uploaded; chunks 1 (20-39) and 2 (40-49) are not.
  const { fetchImpl, calls } = fakeGithub({ existingPaths: new Set(["blobs/quantran/fixed-id/0.enc"]) });
  t.mock.method(globalThis, "fetch", fetchImpl);

  const result = await uploadFile({
    buffer: original,
    fileName: "resume.bin",
    folder: "quantran",
    config: ADMIN_CONFIG,
    id: "fixed-id",
    chunkSize: 20,
  });

  assert.equal(result.chunkCount, 3);
  const putPaths = calls.filter((c) => c.init?.method === "PUT").map((c) =>
    decodeURIComponent(String(c.url).replace("https://api.github.com/repos/fake-owner/fake-repo/contents/", ""))
  );
  assert.deepEqual(putPaths.sort(), ["blobs/quantran/fixed-id/1.enc", "blobs/quantran/fixed-id/2.enc"]);

  const chunk0 = result.chunks.find((c) => c.path === "blobs/quantran/fixed-id/0.enc");
  assert.equal(chunk0.commit_sha, "head-sha");
  assert.equal(chunk0.cdn_url, "https://cdn.jsdelivr.net/gh/fake-owner/fake-repo@head-sha/blobs/quantran/fixed-id/0.enc");
});

test("downloadFile(cdnUrls) throws on an empty array", async () => {
  await assert.rejects(() => downloadFile({ cdnUrls: [], config: ADMIN_CONFIG }), /cdnUrls is empty/);
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
