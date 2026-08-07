// =====================================================================
// src/crypto.js
// ---------------------------------------------------------------------
// AES-256-GCM encryption for arbitrary binary buffers - so a file
// committed into a *public* GitHub repo (required for jsDelivr to serve
// it) is still opaque to anyone who doesn't hold ENCRYPTION_KEY.
//
// Format: iv (12 bytes) || tag (16 bytes) || ciphertext
// The result is self-contained - decryptBuffer needs nothing but the
// key and this one buffer, no separate metadata store.
//
// Same layout telecord's own src/utils/crypto.js already uses for its
// /drive/:token payload, just generalized here from a small JSON-ish
// string to arbitrary file bytes.
// =====================================================================

import crypto from "crypto";

const AES_ALGO = "aes-256-gcm";
const NONCE_SIZE = 12; // GCM-recommended IV length
const TAG_SIZE = 16;   // GCM auth tag length

// Pads or truncates an arbitrary string to exactly 32 bytes so it can be
// used as an AES-256 key. Padding with "0" is fine - predictability of
// the padding doesn't help an attacker who already knows it; key
// strength comes entirely from the caller's secret.
export function normalizedAesKey(key) {
  const normalized = (key || "").padEnd(32, "0");
  return Buffer.from(normalized.slice(0, 32), "utf8");
}

export function encryptBuffer(buffer, key) {
  const aesKey = normalizedAesKey(key);
  const iv = crypto.randomBytes(NONCE_SIZE);
  const cipher = crypto.createCipheriv(AES_ALGO, aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptBuffer(buffer, key) {
  if (buffer.length <= NONCE_SIZE + TAG_SIZE) {
    throw new Error("Invalid encrypted payload: too short to contain iv+tag.");
  }
  const aesKey = normalizedAesKey(key);
  const iv = buffer.subarray(0, NONCE_SIZE);
  const tag = buffer.subarray(NONCE_SIZE, NONCE_SIZE + TAG_SIZE);
  const ciphertext = buffer.subarray(NONCE_SIZE + TAG_SIZE);

  const decipher = crypto.createDecipheriv(AES_ALGO, aesKey, iv);
  decipher.setAuthTag(tag); // GCM verifies on final() - tampering throws here
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Fixed-size chunking for large files (see system.md §3). Two independent
// ceilings, not one: the Contents API's write side chokes on the base64-
// inflated request body well before git's own ~100MB blob cap (tested
// reliably up to 30MB); separately, and more strictly, jsDelivr's own
// GitHub CDN mode - what CLI downloads actually read through - hard-caps
// served files at 20MB ("File size exceeded the configured limit of
// 20 MB", confirmed by hitting it with a 20*1024*1024-byte chunk). 18MB
// clears both with margin.
export const CHUNK_SIZE = 18 * 1024 * 1024; // 18MB

export function splitIntoChunks(buffer, chunkSize = CHUNK_SIZE) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, offset + chunkSize));
  }
  // A zero-byte file still needs exactly one (empty) chunk to round-trip.
  if (chunks.length === 0) chunks.push(buffer.subarray(0, 0));
  return chunks;
}
