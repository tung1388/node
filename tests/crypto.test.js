import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptBuffer, decryptBuffer, normalizedAesKey, splitIntoChunks } from "../src/crypto.js";

const KEY = "test-encryption-key";

test("normalizedAesKey always returns exactly 32 bytes", () => {
  assert.equal(normalizedAesKey("short").length, 32);
  assert.equal(normalizedAesKey("a".repeat(64)).length, 32);
  assert.equal(normalizedAesKey("").length, 32);
});

test("encryptBuffer/decryptBuffer round-trips arbitrary binary data", () => {
  // Non-UTF8-safe bytes (0x00-0xFF), the kind a real image/video would have.
  const original = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const encrypted = encryptBuffer(original, KEY);
  const decrypted = decryptBuffer(encrypted, KEY);
  assert.deepEqual(decrypted, original);
});

test("encryptBuffer produces different ciphertext each call (random IV)", () => {
  const original = Buffer.from("same plaintext");
  const first = encryptBuffer(original, KEY);
  const second = encryptBuffer(original, KEY);
  assert.notDeepEqual(first, second);
  assert.deepEqual(decryptBuffer(first, KEY), original);
  assert.deepEqual(decryptBuffer(second, KEY), original);
});

test("decryptBuffer throws on tampered ciphertext", () => {
  const original = Buffer.from("do not tamper with me");
  const encrypted = encryptBuffer(original, KEY);
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0xff; // flip a byte in the ciphertext
  assert.throws(() => decryptBuffer(tampered, KEY));
});

test("decryptBuffer throws on the wrong key", () => {
  const original = Buffer.from("secret");
  const encrypted = encryptBuffer(original, KEY);
  assert.throws(() => decryptBuffer(encrypted, "wrong-key"));
});

test("decryptBuffer throws on truncated payload", () => {
  assert.throws(() => decryptBuffer(Buffer.from([1, 2, 3]), KEY));
});

test("splitIntoChunks divides evenly and carries the remainder in a final short chunk", () => {
  const buffer = Buffer.from("0123456789"); // 10 bytes
  const chunks = splitIntoChunks(buffer, 3);
  assert.equal(chunks.length, 4); // 3,3,3,1
  assert.deepEqual(Buffer.concat(chunks), buffer);
  assert.equal(chunks[3].length, 1);
});

test("splitIntoChunks returns the whole buffer as one chunk when it fits", () => {
  const buffer = Buffer.from("small");
  const chunks = splitIntoChunks(buffer, 1024);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], buffer);
});

test("splitIntoChunks on an empty buffer returns exactly one empty chunk", () => {
  const chunks = splitIntoChunks(Buffer.alloc(0), 10);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 0);
});

test("each chunk from splitIntoChunks encrypts/decrypts independently (own IV, no cross-chunk state)", () => {
  const buffer = Buffer.from(Array.from({ length: 25 }, (_, i) => i));
  const chunks = splitIntoChunks(buffer, 10);
  const encrypted = chunks.map((c) => encryptBuffer(c, KEY));
  const decrypted = Buffer.concat(encrypted.map((e) => decryptBuffer(e, KEY)));
  assert.deepEqual(decrypted, buffer);
});
