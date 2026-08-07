// Confirms docs/crypto.js (Web Crypto / browser) and src/crypto.js (Node
// crypto module) produce and consume the exact same wire format - a file
// encrypted by one must decrypt correctly with the other. Runs under
// plain Node using its global Web Crypto implementation (available
// since Node 20), so this is real interop, not just an assumption.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptBuffer as nodeEncrypt, decryptBuffer as nodeDecrypt, splitIntoChunks as nodeSplit } from "../src/crypto.js";
import { encryptBuffer as webEncrypt, decryptBuffer as webDecrypt, splitIntoChunks as webSplit } from "../docs/crypto.js";

const KEY = "shared-interop-key";

test("Node-encrypted buffer decrypts correctly via Web Crypto", async () => {
  const original = Buffer.from("plaintext from the Node CLI");
  const encrypted = nodeEncrypt(original, KEY);
  const decrypted = await webDecrypt(new Uint8Array(encrypted), KEY);
  assert.deepEqual(Buffer.from(decrypted), original);
});

test("Web Crypto-encrypted buffer decrypts correctly via Node", async () => {
  const original = new TextEncoder().encode("plaintext from the browser");
  const encrypted = await webEncrypt(original, KEY);
  const decrypted = nodeDecrypt(Buffer.from(encrypted), KEY);
  assert.deepEqual(new Uint8Array(decrypted), original);
});

test("splitIntoChunks agrees between Node and Web Crypto builds for the same input/chunkSize", () => {
  const original = Buffer.from(Array.from({ length: 97 }, (_, i) => i));
  const nodeChunks = nodeSplit(original, 30);
  const webChunks = webSplit(new Uint8Array(original), 30);
  assert.equal(nodeChunks.length, webChunks.length);
  for (let i = 0; i < nodeChunks.length; i += 1) {
    assert.deepEqual(new Uint8Array(nodeChunks[i]), webChunks[i]);
  }
});

test("a file chunked+encrypted in the browser reassembles and decrypts correctly via Node (upload-in-browser, download-via-CLI scenario)", async () => {
  const original = crypto.getRandomValues(new Uint8Array(97));
  const chunks = webSplit(original, 30);
  const encryptedChunks = await Promise.all(chunks.map((c) => webEncrypt(c, KEY)));
  const decrypted = Buffer.concat(encryptedChunks.map((e) => nodeDecrypt(Buffer.from(e), KEY)));
  assert.deepEqual(new Uint8Array(decrypted), original);
});
