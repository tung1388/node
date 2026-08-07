const NONCE_SIZE = 12;
const TAG_SIZE = 16;

function normalizedKeyBytes(passphrase) {
  const padded = (passphrase || "").padEnd(32, "0").slice(0, 32);
  return new TextEncoder().encode(padded);
}

async function importKey(passphrase) {
  return crypto.subtle.importKey("raw", normalizedKeyBytes(passphrase), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptBuffer(bytes, passphrase) {
  const key = await importKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_SIZE));
  const combined = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const ciphertext = combined.slice(0, combined.length - TAG_SIZE);
  const tag = combined.slice(combined.length - TAG_SIZE);

  const out = new Uint8Array(NONCE_SIZE + TAG_SIZE + ciphertext.length);
  out.set(iv, 0);
  out.set(tag, NONCE_SIZE);
  out.set(ciphertext, NONCE_SIZE + TAG_SIZE);
  return out;
}

export async function decryptBuffer(bytes, passphrase) {
  if (bytes.length <= NONCE_SIZE + TAG_SIZE) {
    throw new Error("Invalid encrypted payload: too short to contain iv+tag.");
  }
  const key = await importKey(passphrase);
  const iv = bytes.slice(0, NONCE_SIZE);
  const tag = bytes.slice(NONCE_SIZE, NONCE_SIZE + TAG_SIZE);
  const ciphertext = bytes.slice(NONCE_SIZE + TAG_SIZE);

  // SubtleCrypto wants (ciphertext || tag) as one blob - reassemble it.
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);

  // GCM tag verification happens inside decrypt() - throws on tampering
  // or a wrong key, same as Node's decipher.final().
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
  return new Uint8Array(plain);
}

// ---------------------------------------------------------------------
// Envelope: a 4-byte big-endian length prefix + JSON metadata + the raw
// file bytes, all encrypted together as one blob. This is what lets the
// file browser show a real filename/type/size without a separate
// unencrypted index that would leak that info to anyone browsing the
// (necessarily public) repo.
// ---------------------------------------------------------------------

export function packEnvelope(meta, fileBytes) {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + metaBytes.length + fileBytes.length);
  new DataView(out.buffer).setUint32(0, metaBytes.length, false);
  out.set(metaBytes, 4);
  out.set(fileBytes, 4 + metaBytes.length);
  return out;
}

export function unpackEnvelope(bytes) {
  if (bytes.length < 4) throw new Error("Invalid envelope: too short for a length prefix.");
  const metaLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
  const metaBytes = bytes.slice(4, 4 + metaLen);
  const meta = JSON.parse(new TextDecoder().decode(metaBytes));
  const fileBytes = bytes.slice(4 + metaLen);
  return { meta, fileBytes };
}

// ---------------------------------------------------------------------
// Fixed-size chunking for large files (see system.md §3 / src/crypto.js's
// Node-side twin for the full reasoning: the Contents API's write side
// and jsDelivr's read side each impose their own ceiling, and jsDelivr's
// 20MB cap is the stricter of the two - kept identical here so either
// side can read a chunk the other side wrote).
// ---------------------------------------------------------------------

export const CHUNK_SIZE = 18 * 1024 * 1024; // 18MB - matches src/crypto.js

export function splitIntoChunks(bytes, chunkSize = CHUNK_SIZE) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }
  if (chunks.length === 0) chunks.push(bytes.slice(0, 0));
  return chunks;
}
