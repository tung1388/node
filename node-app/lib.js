// Shared helpers for createJobs.js (create + enqueue) and processQueue.js (poll + download).
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import readline from "readline";
import crypto from "crypto";

export const SERVICES = [
  {
    name: "mukeai",
    api: "mukeai",
    baseUrl: "https://api.mukeai.app",
    generateSerial: () => generateBrowserSerial(),
  },
  {
      name: "photoeditor",
      baseUrl: "https://api.photoeditorai.io/pe/photo-editor",
      generateSerial: () => generateBrowserSerial(),
  },
  // {
  //   name: "ezcreate",
  //   baseUrl: "https://api.ezcreate.ai/ec/ez-create",
  //   generateSerial: () => generateBrowserSerial(),
  // },
  // {
  //     name: "ezremove",
  //     api: "ezremove",
  //     baseUrl: "https://api.ezremove.ai/api/ez-remove/photo-editor",
  //     generateSerial: () => generateBrowserSerial(),
  // },
];

export function findService(name) {
  const service = SERVICES.find((s) => s.name === name);
  if (!service) throw new Error(`Unknown service in queue entry: ${name}`);
  return service;
}

// --input=/--output=/--prompt= CLI flags override the defaults (env vars as a fallback for
// non-interactive/scheduled runs); e.g. --input=face-input --output=face-output --prompt=face-prompt
function argOrEnv(flag, envVar, def) {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (arg) return arg.slice(prefix.length);
  return process.env[envVar] ?? def;
}

export const INPUT_DIR = argOrEnv("input", "INPUT_DIR", "./input");
export const OUTPUT_DIR = argOrEnv("output", "OUTPUT_DIR", "./output");
export const PROMPT_FILE = argOrEnv("prompt", "PROMPT_FILE", "./prompt.txt");
export const PROGRESS_FILE = "./progress.json";
export const QUEUE_FILE = process.env.QUEUE_FILE ?? "./queue.json";

export const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 3);
export const MIN_SUCCESS_PER_IMAGE = Number(
  process.env.MIN_SUCCESS_PER_IMAGE ?? 5,
);
const CONCURRENT_LIMIT_RAW = Number(process.env.CONCURRENT_LIMIT ?? 12);
export const CONCURRENT_LIMIT =
  Number.isFinite(CONCURRENT_LIMIT_RAW) && CONCURRENT_LIMIT_RAW >= 1
    ? CONCURRENT_LIMIT_RAW
    : 12;

export const CREATE_TIMEOUT_MS = Number(process.env.CREATE_TIMEOUT_MS ?? 30000);
export const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 30000);
export const DOWNLOAD_TIMEOUT_MS = Number(
  process.env.DOWNLOAD_TIMEOUT_MS ?? 60000,
);

export const PROGRESS_INTERVAL_MS = Number(
  process.env.PROGRESS_INTERVAL_MS ?? 3000,
);

export const XFF_ENABLED =
  (process.env.XFF_ENABLED ?? "false").toLowerCase() === "true";

export const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export const ALLOWED_OUTPUT_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 422]);

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Formats `{ code, message, ... }`-style JSON bodies returned with HTTP 2xx when the operation failed. */
export function formatApiEnvelope(data, fallback) {
  const bits = [];
  if (data?.code != null) bits.push(`code=${data.code}`);
  let msg = "";
  if (typeof data?.message === "string") msg = data.message.trim();
  else if (data?.message && typeof data.message === "object") {
    const en =
      typeof data.message.en === "string" ? data.message.en.trim() : "";
    const zh =
      typeof data.message.zh === "string" ? data.message.zh.trim() : "";
    msg = [en, zh].filter(Boolean).join(" / ");
  }
  if (msg) bits.push(msg);
  return bits.length ? bits.join(" — ") : fallback;
}

export function rejectCreateEnvelope(data) {
  const formatted = formatApiEnvelope(data, "no job_id in response");
  throw new Error(`Create rejected (${formatted})`);
}

export function generateBrowserSerial() {
  function randomString(length = 11) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  const now = Date.now();
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const twoYears = 2 * oneYear;
  const randomTimestamp =
    now + 10 * twoYears - (oneYear + Math.floor(Math.random() * oneYear));

  return `app_${randomTimestamp}_${randomString()}`;
}

export function randomIp() {
  return `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;
}

export function xffHeaders() {
  if (!XFF_ENABLED) return {};
  const ip = randomIp();
  return {
    "X-Forwarded-For": ip,
    "X-Real-IP": ip,
    "X-Client-IP": ip,
    "X-Originating-IP": ip,
    "True-Client-IP": ip,
    Forwarded: `for=${ip}`,
  };
}

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function askQuestion(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

export function mimeForPath(p) {
  return (
    MIME_BY_EXT[path.extname(p).toLowerCase()] ?? "application/octet-stream"
  );
}

export function safeOutputExt(urlStr) {
  const raw = path.extname(new URL(urlStr).pathname).toLowerCase();
  return ALLOWED_OUTPUT_EXT.has(raw) ? raw : ".png";
}

/** Apply request timeout when ms > 0 (Node 18+ AbortSignal.timeout). */
export function fetchWithTimeout(url, init = {}, ms) {
  if (ms <= 0) return fetch(url, init);
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

export const DEBUG_JOB =
  (process.env.DEBUG_JOB ?? "false").toLowerCase() === "true";

/** Loose match: API may return numeric enums as strings in some edge JSON paths. */
export function isJobSuccessStatus(status) {
  return status === 2 || status === "2";
}

export function isJobFailedStatus(status) {
  return status === 3 || status === "3";
}

/** get-job JSON envelope: these codes mean the response body is usable (not a top-level API error). */
export function isPollEnvelopeOkCode(code) {
  if (code == null || code === "") return true;
  const n = Number(code);
  if (Number.isNaN(n)) return true;
  return n === 200 || n === 100000;
}

/**
 * When `result` is still null while polling, only treat as fatal if the envelope is clearly an error.
 * (Otherwise keep retrying — ezremove/photoeditor often omit `result` until the job exists.)
 */
export function isPollEnvelopeHardErrorWhenNoResult(code) {
  if (code == null || code === "") return false;
  const n = Number(code);
  if (Number.isNaN(n)) return false;
  if (n === 200 || n === 100000) return false;
  if (n >= 400000 && n < 600000) return true;
  if (n >= 400 && n < 500) return true;
  return false;
}

/**
 * Extract first HTTPS URL from get-job `result` (array of strings, array of objects, or flat fields).
 */
export function extractJobOutputUrl(result) {
  if (!result || typeof result !== "object") return null;

  const tryString = (s) =>
    typeof s === "string" && /^https?:\/\//i.test(s) ? s : null;

  if (Array.isArray(result.image_url)) {
    for (const item of result.image_url) {
      const u = tryString(
        typeof item === "string" ? item : (item?.url ?? item?.uri),
      );
      if (u) return u;
    }
  }

  const out = result.output;
  if (typeof out === "string") {
    const u = tryString(out);
    if (u) return u;
  }
  if (Array.isArray(out)) {
    for (const item of out) {
      if (typeof item === "string") {
        const u = tryString(item);
        if (u) return u;
      }
      if (item && typeof item === "object") {
        const u = tryString(
          item.url ??
            item.uri ??
            item.signed_url ??
            item.image_url ??
            item.output_url ??
            item.href,
        );
        if (u) return u;
      }
    }
  } else if (out && typeof out === "object") {
    const u = tryString(
      out.url ?? out.uri ?? out.signed_url ?? out.image_url ?? out.output_url,
    );
    if (u) return u;
  }

  return tryString(
    result.output_url ??
      result.image_url ??
      result.result_url ??
      result.url ??
      result.signed_url,
  );
}

// Returns a stable directory-component prefix for a relative imageFile path.
export function imageDirName(imageFile) {
  const normalized = imageFile.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const stem = sanitizeFilename(path.parse(parts[parts.length - 1]).name);
  if (parts.length === 1) return stem;
  const dirPart = parts.slice(0, -1).map(sanitizeFilename).join("__");
  return `${dirPart}__${stem}`;
}

export function promptDirName(prompt) {
  const slug = prompt
    .slice(0, 30)
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const hash = crypto
    .createHash("sha1")
    .update(prompt)
    .digest("hex")
    .slice(0, 8);
  return slug ? `${slug}_${hash}` : hash;
}

export function pairFilePrefix(imageFile, prompt) {
  return `${imageDirName(imageFile)}__${promptDirName(prompt)}`;
}

// Scan INPUT_DIR recursively and return relative paths (forward-slash, e.g. "sub/image.jpg")
export function scanInputImages(dir, baseDir) {
  baseDir = baseDir ?? dir;
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanInputImages(fullPath, baseDir));
    } else if (/\.(jpg|jpeg|png|webp)$/i.test(entry.name)) {
      results.push(path.relative(baseDir, fullPath).replace(/\\/g, "/"));
    }
  }
  return results;
}

export function countExistingOutputs(imageFile, prompt) {
  const subDir = path.posix.dirname(imageFile);
  const scanDir =
    !subDir || subDir === "." ? OUTPUT_DIR : path.join(OUTPUT_DIR, subDir);
  if (!fs.existsSync(scanDir)) return 0;
  const prefix = `${pairFilePrefix(imageFile, prompt)}__`;
  return fs
    .readdirSync(scanDir)
    .filter(
      (f) =>
        f.startsWith(prefix) &&
        ALLOWED_OUTPUT_EXT.has(path.extname(f).toLowerCase()),
    ).length;
}

// ---------- Job creation ----------

export async function createJob(imagePath, imageName, prompt, serial, service) {
  const baseUrl = service.baseUrl;

  if (service.api === "mukeai") {
    const fileBuf = await fsp.readFile(imagePath);
    const form = new FormData();
    form.append(
      "image",
      new Blob([fileBuf], { type: mimeForPath(imagePath) }),
      imageName,
    );
    form.append("prompt", prompt);
    form.append("negative_prompt", "");
    form.append("model_type", "standard");
    form.append("aspect_ratio", "match_input_image");

    const response = await fetchWithTimeout(
      `${baseUrl}/api/muke/image-generate/image2image`,
      {
        method: "POST",
        headers: { "product-serial": serial, ...xffHeaders() },
        body: form,
      },
      CREATE_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new HttpError(
        `Create job failed: ${response.status}`,
        response.status,
      );
    }

    const data = await response.json();
    const jobId = data?.result?.job_id;
    if (jobId != null && jobId !== "") return data;

    rejectCreateEnvelope(data);
  }

  const fileBuf = await fsp.readFile(imagePath);
  const form = new FormData();
  form.append("model_name", "photoeditor_4.0");
  form.append(
    "target_images",
    new Blob([fileBuf], { type: mimeForPath(imagePath) }),
    imageName,
  );
  form.append("prompt", prompt);
  form.append("ratio", "match_input_image");
  form.append("image_resolution", "2K");

  const response = await fetchWithTimeout(
    `${baseUrl}/create-job`,
    {
      method: "POST",
      headers: { "product-serial": serial, ...xffHeaders() },
      body: form,
    },
    CREATE_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new HttpError(
      `Create job failed: ${response.status}`,
      response.status,
    );
  }

  const data = await response.json();
  const jobId = data?.result?.job_id;
  if (jobId != null && jobId !== "") return data;

  rejectCreateEnvelope(data);
}

// ---------- Job status check (single-shot, no internal loop, no retry) ----------
// Every processQueue.js run checks each queued job exactly once. "progress" means the caller
// should leave the entry queued and check again on the next run; only "done" or a thrown
// error (genuine API rejection / job failure) resolves it.

/** Marks an error as a definitive, unrecoverable job failure — processQueue.js removes these
 * from the queue regardless of --delete=true, since rechecking would just repeat forever. */
function permanentError(message) {
  return Object.assign(new Error(message), { permanent: true });
}

async function checkPhotoeditorJobOnce(jobId, serial, baseUrl) {
  const jobUrl = `${baseUrl}/get-job/${jobId}`;
  const jobRes = await fetchWithTimeout(
    jobUrl,
    { headers: { "product-serial": serial, ...xffHeaders() } },
    POLL_TIMEOUT_MS,
  );

  if (!jobRes.ok) {
    // ezcreate returns a plain FastAPI-style {"detail": "Not Found"} body on 404.
    let detail;
    try {
      const body = await jobRes.json();
      detail = typeof body?.detail === "string" ? body.detail : undefined;
    } catch {}
    if (detail)
      throw permanentError(`Get job failed: ${jobRes.status} (${detail})`);
    throw new HttpError(`Get job failed: ${jobRes.status}`, jobRes.status);
  }

  const jobData = await jobRes.json();

  // Some services (ezcreate) can also respond 200 with a {"detail": "..."} error envelope.
  if (typeof jobData?.detail === "string") {
    throw permanentError(jobData.detail);
  }

  const result = jobData?.result;

  if (result == null) {
    if (isPollEnvelopeHardErrorWhenNoResult(jobData?.code)) {
      throw new Error(
        `Get job refused (${formatApiEnvelope(jobData, "no result")})`,
      );
    }
    return { status: "progress" };
  }

  const envCode = jobData?.code;
  if (envCode != null && !isPollEnvelopeOkCode(envCode)) {
    throw new Error(
      `Get job refused (${formatApiEnvelope(jobData, "unexpected envelope code")})`,
    );
  }

  const status = result.status;
  if (isJobSuccessStatus(status)) {
    const url = extractJobOutputUrl(result);
    if (url) return { status: "done", url };
    return { status: "progress" };
  }
  if (isJobFailedStatus(status))
    throw permanentError(result.error || "Generation failed");

  // Any other status that already carries a non-empty `error` (e.g. ezcreate's status=4) is
  // just as terminal as status===3 — don't wait around hoping it changes.
  if (typeof result.error === "string" && result.error.trim() !== "") {
    throw permanentError(result.error);
  }

  return { status: "progress" };
}

async function checkEzremoveJobOnce(jobId, serial, baseUrl) {
  const jobUrl = `${baseUrl}/get-job/${jobId}`;
  const jobRes = await fetchWithTimeout(
    jobUrl,
    { headers: { "product-serial": serial, ...xffHeaders() } },
    POLL_TIMEOUT_MS,
  );

  if (!jobRes.ok) {
    throw new HttpError(`Get job failed: ${jobRes.status}`, jobRes.status);
  }

  const jobData = await jobRes.json();
  const result = jobData?.result;

  if (result == null) {
    if (isPollEnvelopeHardErrorWhenNoResult(jobData?.code)) {
      throw new Error(
        `Get job refused (${formatApiEnvelope(jobData, "no result")})`,
      );
    }
    return { status: "progress" };
  }

  const status = result.status;
  if (isJobFailedStatus(status)) {
    const errText = typeof result.error === "string" ? result.error.trim() : "";
    throw permanentError(errText || "Generation failed");
  }
  if (isJobSuccessStatus(status)) {
    const url = extractJobOutputUrl(result);
    if (url) return { status: "done", url };
    return { status: "progress" };
  }

  return { status: "progress" };
}

async function checkMukeaiJobOnce(jobId, serial, baseUrl) {
  const resultUrl = `${baseUrl}/api/result/get?job_id=${encodeURIComponent(jobId)}&_t=${Date.now()}`;
  const jobRes = await fetchWithTimeout(
    resultUrl,
    { headers: { "product-serial": serial, ...xffHeaders() } },
    POLL_TIMEOUT_MS,
  );

  if (!jobRes.ok) {
    throw new HttpError(`Get job failed: ${jobRes.status}`, jobRes.status);
  }

  const jobData = await jobRes.json();
  const codeRaw = jobData?.code;

  if (codeRaw != null) {
    const code = Number(codeRaw);
    if (code === 202) return { status: "progress" };
    if (code !== 200) {
      const formatted = formatApiEnvelope(
        jobData,
        `unexpected code ${codeRaw}`,
      );
      throw new Error(`Get job refused (${formatted})`);
    }
  }

  const result = jobData?.result;
  if (result == null) {
    if (codeRaw != null && Number(codeRaw) === 200) {
      const formatted = formatApiEnvelope(
        jobData,
        "code=200 but result is null",
      );
      throw new Error(`Get job refused (${formatted})`);
    }
    return { status: "progress" };
  }

  const url = extractJobOutputUrl(result);
  if (url) return { status: "done", url };

  if (isJobFailedStatus(result.status))
    throw permanentError(result.error || "Generation failed");

  return { status: "progress" };
}

/** Single status check for any service — no internal loop, no retry on transient errors. */
export async function checkJobOnce(jobId, serial, service) {
  if (service.api === "mukeai")
    return checkMukeaiJobOnce(jobId, serial, service.baseUrl);
  if (service.api === "ezremove")
    return checkEzremoveJobOnce(jobId, serial, service.baseUrl);
  return checkPhotoeditorJobOnce(jobId, serial, service.baseUrl);
}

export async function downloadImage(outputUrl) {
  const imageRes = await fetchWithTimeout(outputUrl, {}, DOWNLOAD_TIMEOUT_MS);
  if (!imageRes.ok) {
    throw new HttpError(`Download failed: ${imageRes.status}`, imageRes.status);
  }
  return imageRes.arrayBuffer();
}

export function isRetryable(err) {
  const m = String(err?.message ?? "");
  if (
    /Insufficient credits|Create rejected .*code=400005|Get job refused .*code=400005/i.test(
      m,
    )
  )
    return false;
  if (err instanceof HttpError && NON_RETRYABLE_STATUSES.has(err.status))
    return false;
  return true;
}

export function categorizeError(err) {
  const m = err?.message ?? "";
  if (!err) return "other";
  if (err.name === "AbortError" || /aborted|timed? out/i.test(m))
    return "timeout";
  if (err instanceof HttpError) {
    if (err.status === 429) return "http_429";
    if (err.status >= 500) return "http_5xx";
    if (err.status >= 400) return "http_4xx";
  }
  if (/Insufficient credits/i.test(m)) return "insufficient_credits";
  if (/Create rejected \(code=/i.test(m)) return "create_api_error";
  if (/Get job refused \(code=/i.test(m)) return "poll_api_error";
  if (/no job_id returned/i.test(m)) return "no_job_id";
  if (/polling timed out/i.test(m)) return "poll_timeout";
  if (/Generation failed/i.test(m)) return "gen_failed";
  if (
    err.code === "ECONNRESET" ||
    err.code === "ENOTFOUND" ||
    err.code === "ECONNREFUSED"
  )
    return "network";
  if (/ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(m))
    return "network";
  return "other";
}

// ---------- Progress (completed count per image+prompt pair) ----------

let progressMap = new Map();

export async function loadProgress(imageFiles, prompts) {
  try {
    const raw = await fsp.readFile(PROGRESS_FILE, "utf8");
    const obj = JSON.parse(raw);
    progressMap = new Map(
      Object.entries(obj).map(([k, v]) => [k, Number(v) || 0]),
    );
    return;
  } catch {
    // No progress file — seed from filesystem scan (one-time migration)
  }
  progressMap = new Map();
  for (const imageFile of imageFiles) {
    for (const prompt of prompts) {
      const count = countExistingOutputs(imageFile, prompt);
      if (count > 0) progressMap.set(pairFilePrefix(imageFile, prompt), count);
    }
  }
  await flushProgress();
}

export async function flushProgress() {
  try {
    await fsp.writeFile(
      PROGRESS_FILE,
      JSON.stringify(Object.fromEntries(progressMap), null, 2),
    );
  } catch {
    // best-effort
  }
}

export function getProgress(imageFile, prompt) {
  return progressMap.get(pairFilePrefix(imageFile, prompt)) ?? 0;
}

export function incrementProgress(imageFile, prompt) {
  const key = pairFilePrefix(imageFile, prompt);
  progressMap.set(key, (progressMap.get(key) ?? 0) + 1);
  flushProgress().catch(() => {});
}

// ---------- Job queue (shared between createJobs.js and processQueue.js) ----------

export async function loadQueue() {
  try {
    const raw = await fsp.readFile(QUEUE_FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function saveQueue(entries) {
  await fsp.writeFile(QUEUE_FILE, JSON.stringify(entries, null, 2));
}

// ---------- Misc ----------

export async function appendOutputLog(line) {
  await fsp.appendFile("./outputs.log", `${line}\n`, "utf8");
}

export async function runConcurrent(tasks, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= tasks.length) break;
      results[currentIndex] = await tasks[currentIndex]();
    }
  }

  const workers = [];
  for (let i = 0; i < limit; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ---------- Tuple selection parser (createJobs.js CLI) ----------

export function range(n) {
  return Array.from({ length: n }, (_, i) => i);
}

export function validIdx(s, max, kind) {
  const n = parseInt(s, 10);
  if (!Number.isInteger(n) || n < 0 || n >= max) {
    throw new Error(`Invalid ${kind} index: ${s} (must be 0..${max - 1})`);
  }
  return n;
}

export function parseSelection(input, imageCount, promptCount) {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "a" || trimmed === "all") {
    const all = [];
    for (let i = 0; i < imageCount; i++) {
      for (let p = 0; p < promptCount; p++)
        all.push({ imageIndex: i, promptIndex: p });
    }
    return all;
  }

  const re = /\(\s*(\d+|\*)\s*,\s*(\d+|\*)\s*\)/g;
  const dedup = new Set();
  const out = [];
  let m;
  while ((m = re.exec(input)) !== null) {
    const imgs =
      m[1] === "*" ? range(imageCount) : [validIdx(m[1], imageCount, "image")];
    const prms =
      m[2] === "*"
        ? range(promptCount)
        : [validIdx(m[2], promptCount, "prompt")];
    for (const i of imgs) {
      for (const p of prms) {
        const k = `${i}\0${p}`;
        if (!dedup.has(k)) {
          dedup.add(k);
          out.push({ imageIndex: i, promptIndex: p });
        }
      }
    }
  }

  if (out.length === 0) {
    throw new Error('No valid tuples parsed. Examples: "(0,1) (*,2)" or "a"');
  }
  return out;
}

export function getArgValue(flag) {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

// Return the sorted list of top-level subdirectory names present among imageFiles.
export function getTopLevelFolders(imageFiles) {
  const seen = new Set();
  for (const f of imageFiles) {
    const slash = f.indexOf("/");
    seen.add(slash === -1 ? "." : f.slice(0, slash));
  }
  return [...seen].sort((a, b) => {
    if (a === ".") return -1;
    if (b === ".") return 1;
    return a.localeCompare(b);
  });
}

// Filter imageFiles to those inside the given top-level folder ("." = root only).
export function filterByFolder(imageFiles, folder) {
  if (folder === "." || folder === "")
    return imageFiles.filter((f) => !f.includes("/"));
  return imageFiles.filter((f) => f === folder || f.startsWith(folder + "/"));
}
