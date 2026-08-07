import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import readline from "readline"
import crypto from "crypto"

const SERVICES = [
    {
        name: "ezcreate",
        baseUrl: "https://api.ezcreate.ai/ec/ez-create",
        generateSerial: () => generateBrowserSerial(),
    },
    // {
    //     name: "ezremove",
    //     api: "ezremove",
    //     baseUrl: "https://api.ezremove.ai/api/ez-remove/photo-editor",
    //     generateSerial: () => generateBrowserSerial(),
    // },
    // {
    //     name: "photoeditor",
    //     baseUrl: "https://api.photoeditorai.io/pe/photo-editor",
    //     generateSerial: () => generateBrowserSerial(),
    // },
    {
        name: "mukeai",
        api: "mukeai",
        baseUrl: "https://api.mukeai.app",
        generateSerial: () => generateBrowserSerial()
    },
]

const INPUT_DIR = "./input"
const OUTPUT_DIR = "./output"
const PROMPT_FILE = "./prompt.txt"
const PROGRESS_FILE = "./progress.json"

const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 3)
const MIN_SUCCESS_PER_IMAGE = Number(process.env.MIN_SUCCESS_PER_IMAGE ?? 5)
const CONCURRENT_LIMIT_RAW = Number(process.env.CONCURRENT_LIMIT ?? 12)
const CONCURRENT_LIMIT = Number.isFinite(CONCURRENT_LIMIT_RAW) && CONCURRENT_LIMIT_RAW >= 1 ? CONCURRENT_LIMIT_RAW : 12
// Number of concurrent requests to fire per needed slot — first success wins, extras are bonus
const FIRE_N_PER_SLOT = Number(process.env.FIRE_N_PER_SLOT ?? 1)

const MAX_POLLS = Number(process.env.MAX_POLLS ?? 60)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 3000)

const CREATE_TIMEOUT_MS = Number(process.env.CREATE_TIMEOUT_MS ?? 30000)
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 30000)
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS ?? 60000)

const PROGRESS_INTERVAL_MS = Number(process.env.PROGRESS_INTERVAL_MS ?? 3000)

const XFF_ENABLED = (process.env.XFF_ENABLED ?? "false").toLowerCase() === "true"

const MIME_BY_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}

const ALLOWED_OUTPUT_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"])
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 422])

class HttpError extends Error {
    constructor(message, status) {
        super(message)
        this.status = status
    }
}

/** Formats `{ code, message, ... }`-style JSON bodies returned with HTTP 2xx when the operation failed. */
function formatApiEnvelope(data, fallback) {
    const bits = []
    if (data?.code != null) bits.push(`code=${data.code}`)
    let msg = ""
    if (typeof data?.message === "string") msg = data.message.trim()
    else if (data?.message && typeof data.message === "object") {
        const en = typeof data.message.en === "string" ? data.message.en.trim() : ""
        const zh = typeof data.message.zh === "string" ? data.message.zh.trim() : ""
        msg = [en, zh].filter(Boolean).join(" / ")
    }
    if (msg) bits.push(msg)
    return bits.length ? bits.join(" — ") : fallback
}

function rejectCreateEnvelope(data) {
    const formatted = formatApiEnvelope(data, "no job_id in response")
    throw new Error(`Create rejected (${formatted})`)
}

function generateBrowserSerial() {
    function randomString(length = 11) {
        const chars = "abcdefghijklmnopqrstuvwxyz0123456789"

        let result = ""

        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length))
        }

        return result
    }

    const now = Date.now()

    const oneYear = 365 * 24 * 60 * 60 * 1000
    const twoYears = 2 * oneYear

    const randomTimestamp = now + 10 * twoYears - (oneYear + Math.floor(Math.random() * oneYear))

    return `app_${randomTimestamp}_${randomString()}`
}

function randomIp() {
    return `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`
}

function xffHeaders() {
    if (!XFF_ENABLED) return {}
    const ip = randomIp()
    return {
        "X-Forwarded-For": ip,
        "X-Real-IP": ip,
        "X-Client-IP": ip,
        "X-Originating-IP": ip,
        "True-Client-IP": ip,
        // "CF-Connecting-IP": ip,
        "Forwarded": `for=${ip}`,
    }
}

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function askQuestion(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close()
            resolve(answer)
        })
    })
}

function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
}

function mimeForPath(p) {
    return MIME_BY_EXT[path.extname(p).toLowerCase()] ?? "application/octet-stream"
}

function safeOutputExt(urlStr) {
    const raw = path.extname(new URL(urlStr).pathname).toLowerCase()
    return ALLOWED_OUTPUT_EXT.has(raw) ? raw : ".png"
}

/** Apply request timeout when ms > 0 (Node 18+ AbortSignal.timeout). */
function fetchWithTimeout(url, init = {}, ms) {
    if (ms <= 0) return fetch(url, init)
    return fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
}

const DEBUG_JOB = (process.env.DEBUG_JOB ?? "false").toLowerCase() === "true"

/** Loose match: API may return numeric enums as strings in some edge JSON paths. */
function isJobSuccessStatus(status) {
    return status === 2 || status === "2"
}

function isJobFailedStatus(status) {
    return status === 3 || status === "3"
}

/** get-job JSON envelope: these codes mean the response body is usable (not a top-level API error). */
function isPollEnvelopeOkCode(code) {
    if (code == null || code === "") return true
    const n = Number(code)
    if (Number.isNaN(n)) return true
    return n === 200 || n === 100000
}

/**
 * When `result` is still null while polling, only treat as fatal if the envelope is clearly an error.
 * (Otherwise keep retrying — ezremove/photoeditor often omit `result` until the job exists.)
 */
function isPollEnvelopeHardErrorWhenNoResult(code) {
    if (code == null || code === "") return false
    const n = Number(code)
    if (Number.isNaN(n)) return false
    if (n === 200 || n === 100000) return false
    if (n >= 400000 && n < 600000) return true
    if (n >= 400 && n < 500) return true
    return false
}

/**
 * Extract first HTTPS URL from get-job `result` (array of strings, array of objects, or flat fields).
 */
function extractJobOutputUrl(result) {
    if (!result || typeof result !== "object") return null

    const tryString = (s) => (typeof s === "string" && /^https?:\/\//i.test(s) ? s : null)

    if (Array.isArray(result.image_url)) {
        for (const item of result.image_url) {
            const u = tryString(typeof item === "string" ? item : item?.url ?? item?.uri)
            if (u) return u
        }
    }

    const out = result.output
    if (typeof out === "string") {
        const u = tryString(out)
        if (u) return u
    }
    if (Array.isArray(out)) {
        for (const item of out) {
            if (typeof item === "string") {
                const u = tryString(item)
                if (u) return u
            }
            if (item && typeof item === "object") {
                const u = tryString(
                    item.url ??
                        item.uri ??
                        item.signed_url ??
                        item.image_url ??
                        item.output_url ??
                        item.href,
                )
                if (u) return u
            }
        }
    } else if (out && typeof out === "object") {
        const u = tryString(out.url ?? out.uri ?? out.signed_url ?? out.image_url ?? out.output_url)
        if (u) return u
    }

    return tryString(
        result.output_url ?? result.image_url ?? result.result_url ?? result.url ?? result.signed_url,
    )
}

// Returns a stable directory-component prefix for a relative imageFile path.
// For root-level files (e.g. "image.jpg") the result is just the stem — same as the
// old behaviour so existing progress.json keys stay valid.
// For sub-folder files (e.g. "folderA/image.jpg") the result is "folderA__image".
function imageDirName(imageFile) {
    const normalized = imageFile.replace(/\\/g, "/")
    const parts = normalized.split("/")
    const stem = sanitizeFilename(path.parse(parts[parts.length - 1]).name)
    if (parts.length === 1) return stem                 // root-level — backward-compatible
    const dirPart = parts.slice(0, -1).map(sanitizeFilename).join("__")
    return `${dirPart}__${stem}`
}

function promptDirName(prompt) {
    const slug = prompt.slice(0, 30).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    const hash = crypto.createHash("sha1").update(prompt).digest("hex").slice(0, 8)
    return slug ? `${slug}_${hash}` : hash
}

function pairFilePrefix(imageFile, prompt) {
    return `${imageDirName(imageFile)}__${promptDirName(prompt)}`
}

// Scan INPUT_DIR recursively and return relative paths (forward-slash, e.g. "sub/image.jpg")
function scanInputImages(dir, baseDir) {
    baseDir = baseDir ?? dir
    const results = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            results.push(...scanInputImages(fullPath, baseDir))
        } else if (/\.(jpg|jpeg|png|webp)$/i.test(entry.name)) {
            // Store as forward-slash relative path for consistency across platforms
            results.push(path.relative(baseDir, fullPath).replace(/\\/g, "/"))
        }
    }
    return results
}

function countExistingOutputs(imageFile, prompt) {
    const subDir = path.posix.dirname(imageFile)
    const scanDir = (!subDir || subDir === ".") ? OUTPUT_DIR : path.join(OUTPUT_DIR, subDir)
    if (!fs.existsSync(scanDir)) return 0
    const prefix = `${pairFilePrefix(imageFile, prompt)}__`
    return fs
        .readdirSync(scanDir)
        .filter((f) => f.startsWith(prefix) && ALLOWED_OUTPUT_EXT.has(path.extname(f).toLowerCase()))
        .length
}

async function createJob(imagePath, imageName, prompt, serial, service) {
    const baseUrl = service.baseUrl

    if (service.api === "mukeai") {
        const fileBuf = await fsp.readFile(imagePath)
        const form = new FormData()
        form.append("image", new Blob([fileBuf], { type: mimeForPath(imagePath) }), imageName)
        form.append("prompt", prompt)
        form.append("negative_prompt", "")
        form.append("model_type", "standard")
        form.append("aspect_ratio", "match_input_image")

        const response = await fetchWithTimeout(
            `${baseUrl}/api/muke/image-generate/image2image`,
            {
                method: "POST",
                headers: { "product-serial": serial, ...xffHeaders() },
                body: form,
            },
            CREATE_TIMEOUT_MS,
        )

        if (!response.ok) {
            throw new HttpError(`Create job failed: ${response.status}`, response.status)
        }

        const data = await response.json()
        const jobId = data?.result?.job_id
        if (jobId != null && jobId !== "") return data

        rejectCreateEnvelope(data)
    }

    const fileBuf = await fsp.readFile(imagePath)
    const form = new FormData()
    form.append("model_name", "photoeditor_4.0")
    form.append("target_images", new Blob([fileBuf], { type: mimeForPath(imagePath) }), imageName)
    form.append("prompt", prompt)
    form.append("ratio", "match_input_image")
    form.append("image_resolution", "2K")

    const response = await fetchWithTimeout(
        `${baseUrl}/create-job`,
        {
            method: "POST",
            headers: { "product-serial": serial, ...xffHeaders() },
            body: form,
        },
        CREATE_TIMEOUT_MS,
    )

    if (!response.ok) {
        throw new HttpError(`Create job failed: ${response.status}`, response.status)
    }

    const data = await response.json()
    const jobId = data?.result?.job_id
    if (jobId != null && jobId !== "") return data

    rejectCreateEnvelope(data)
}

/** Muke AI: GET /api/result/get — done when result.image_url has a URL (no status enum). */
async function waitForJobMukeai(jobId, serial, baseUrl) {
    for (let poll = 0; poll < MAX_POLLS; poll++) {
        await sleep(POLL_INTERVAL_MS)

        const resultUrl = `${baseUrl}/api/result/get?job_id=${encodeURIComponent(jobId)}&_t=${Date.now()}`
        const jobRes = await fetchWithTimeout(
            resultUrl,
            { headers: { "product-serial": serial, ...xffHeaders() } },
            POLL_TIMEOUT_MS,
        )

        if (!jobRes.ok) {
            throw new HttpError(`Get job failed: ${jobRes.status}`, jobRes.status)
        }

        const jobData = await jobRes.json()
        const codeRaw = jobData?.code

        if (codeRaw != null) {
            const code = Number(codeRaw)
            if (code === 202) {
                if (DEBUG_JOB) {
                    console.log(`[DEBUG_JOB] muke job=${jobId} code=202 ${formatApiEnvelope(jobData, "in progress")}`)
                }
                continue
            }
            if (code !== 200) {
                const formatted = formatApiEnvelope(jobData, `unexpected code ${codeRaw}`)
                throw new Error(`Get job refused (${formatted})`)
            }
        }

        const result = jobData?.result
        if (result == null) {
            if (codeRaw != null && Number(codeRaw) === 200) {
                const formatted = formatApiEnvelope(jobData, "code=200 but result is null")
                throw new Error(`Get job refused (${formatted})`)
            }
            continue
        }

        if (DEBUG_JOB) {
            const hasImg = Array.isArray(result.image_url) ? result.image_url.length : 0
            console.log(`[DEBUG_JOB] muke job=${jobId} image_url_len=${hasImg} keys=${Object.keys(result).join(",")}`)
        }

        const url = extractJobOutputUrl(result)
        if (url) return url

        if (isJobFailedStatus(result.status)) throw new Error(result.error || "Generation failed")

        // e.g. code 200 but image_url not yet populated — keep polling
    }

    throw new Error(`Job ${jobId} polling timed out after ${MAX_POLLS} attempts`)
}

/**
 * ezremove: poll GET /get-job/:id until `result.status` is 2 (then return output URL), or fail on 3.
 * Ignores top-level JSON `code` when `result` is present so in-progress payloads are not misclassified.
 */
async function waitForJobEzremove(jobId, serial, baseUrl) {
    const jobUrl = `${baseUrl}/get-job/${jobId}`

    for (let poll = 0; poll < MAX_POLLS; poll++) {
        await sleep(POLL_INTERVAL_MS)

        const jobRes = await fetchWithTimeout(
            jobUrl,
            { headers: { "product-serial": serial, ...xffHeaders() } },
            POLL_TIMEOUT_MS,
        )

        if (!jobRes.ok) {
            throw new HttpError(`Get job failed: ${jobRes.status}`, jobRes.status)
        }

        const jobData = await jobRes.json()
        const result = jobData?.result

        if (result == null) {
            if (isPollEnvelopeHardErrorWhenNoResult(jobData?.code)) {
                throw new Error(`Get job refused (${formatApiEnvelope(jobData, "no result")})`)
            }
            if (DEBUG_JOB) {
                console.log(`[DEBUG_JOB] ezremove job=${jobId} poll: result null — retry`)
            }
            continue
        }

        const status = result.status
        if (DEBUG_JOB) {
            console.log(
                `[DEBUG_JOB] ezremove job=${jobId} status=${JSON.stringify(status)} output=${Array.isArray(result.output) ? `array(len=${result.output.length})` : typeof result.output}`,
            )
        }

        if (isJobFailedStatus(status)) {
            const errText = typeof result.error === "string" ? result.error.trim() : ""
            throw new Error(errText || "Generation failed")
        }

        if (isJobSuccessStatus(status)) {
            const url = extractJobOutputUrl(result)
            if (url) return url
            if (DEBUG_JOB) {
                console.log(
                    `[DEBUG_JOB] ezremove job=${jobId} status=2 but no usable output URL yet — retry`,
                )
            }
            continue
        }

        // status 0, 1, or unknown — still processing
    }

    throw new Error(`Job ${jobId} polling timed out after ${MAX_POLLS} attempts`)
}

async function waitForJob(jobId, serial, service) {
    if (service.api === "mukeai") {
        return waitForJobMukeai(jobId, serial, service.baseUrl)
    }

    if (service.api === "ezremove") {
        return waitForJobEzremove(jobId, serial, service.baseUrl)
    }

    const baseUrl = service.baseUrl
    const jobUrl = `${baseUrl}/get-job/${jobId}`

    for (let poll = 0; poll < MAX_POLLS; poll++) {
        await sleep(POLL_INTERVAL_MS)

        const jobRes = await fetchWithTimeout(
            jobUrl,
            { headers: { "product-serial": serial, ...xffHeaders() } },
            POLL_TIMEOUT_MS,
        )

        if (!jobRes.ok) {
            throw new HttpError(`Get job failed: ${jobRes.status}`, jobRes.status)
        }

        const jobData = await jobRes.json()

        const result = jobData?.result
        if (result == null) {
            if (isPollEnvelopeHardErrorWhenNoResult(jobData?.code)) {
                throw new Error(`Get job refused (${formatApiEnvelope(jobData, "no result")})`)
            }
            if (DEBUG_JOB) {
                console.log(`[DEBUG_JOB] job=${jobId} poll: result null, envelope code=${jobData?.code} — retry`)
            }
            continue
        }

        const envCode = jobData?.code
        if (envCode != null && !isPollEnvelopeOkCode(envCode)) {
            throw new Error(`Get job refused (${formatApiEnvelope(jobData, "unexpected envelope code")})`)
        }

        const status = result.status
        if (DEBUG_JOB) {
            console.log(`[DEBUG_JOB] job=${jobId} status=${JSON.stringify(status)} output_type=${Array.isArray(result.output) ? "array" : typeof result.output}`)
        }

        if (isJobSuccessStatus(status)) {
            const url = extractJobOutputUrl(result)
            if (url) return url
            if (DEBUG_JOB) {
                console.log(
                    `[DEBUG_JOB] job=${jobId} status=2 but no usable output URL yet (keys=${Object.keys(result).join(",")}) — retry`,
                )
            }
            continue
        }
        if (isJobFailedStatus(status)) throw new Error(result.error || "Generation failed")
    }

    throw new Error(`Job ${jobId} polling timed out after ${MAX_POLLS} attempts`)
}

async function downloadImage(outputUrl) {
    const imageRes = await fetchWithTimeout(outputUrl, {}, DOWNLOAD_TIMEOUT_MS)
    if (!imageRes.ok) {
        throw new HttpError(`Download failed: ${imageRes.status}`, imageRes.status)
    }
    return imageRes.arrayBuffer()
}

function isRetryable(err) {
    const m = String(err?.message ?? "")
    if (/Insufficient credits|Create rejected .*code=400005|Get job refused .*code=400005/i.test(m)) return false
    if (err instanceof HttpError && NON_RETRYABLE_STATUSES.has(err.status)) return false
    return true
}

function categorizeError(err) {
    const m = err?.message ?? ""
    if (!err) return "other"
    if (err.name === "AbortError" || /aborted|timed? out/i.test(m)) return "timeout"
    if (err instanceof HttpError) {
        if (err.status === 429) return "http_429"
        if (err.status >= 500) return "http_5xx"
        if (err.status >= 400) return "http_4xx"
    }
    if (/Insufficient credits/i.test(m)) return "insufficient_credits"
    if (/Create rejected \(code=/i.test(m)) return "create_api_error"
    if (/Get job refused \(code=/i.test(m)) return "poll_api_error"
    if (/no job_id returned/i.test(m)) return "no_job_id"
    if (/polling timed out/i.test(m)) return "poll_timeout"
    if (/Generation failed/i.test(m)) return "gen_failed"
    if (err.code === "ECONNRESET" || err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") return "network"
    if (/ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(m)) return "network"
    return "other"
}

// ---------- Stats + logging ----------

async function appendOutputLog(line) {
    await fsp.appendFile("./outputs.log", `${line}\n`, "utf8")
}

const stats = {
    total: 0,
    succeeded: 0,
    errors: {},
    byService: Object.fromEntries(SERVICES.map((s) => [s.name, 0])),
}

function bumpError(category) {
    stats.errors[category] = (stats.errors[category] ?? 0) + 1
}

function bumpServiceSuccess(serviceName) {
    stats.byService[serviceName] = (stats.byService[serviceName] ?? 0) + 1
}

function serviceFilesTotal() {
    return SERVICES.reduce((n, s) => n + (stats.byService[s.name] ?? 0), 0)
}

function printProgress() {
    const failed = Object.values(stats.errors).reduce((a, b) => a + b, 0)
    const completed = stats.succeeded + failed
    const filesWritten = serviceFilesTotal()
    const errParts = Object.entries(stats.errors)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
    const bonus = filesWritten > stats.succeeded ? ` | files_saved=${filesWritten}` : ""
    console.log(
        `[Progress] ${completed}/${stats.total} slots | slots_filled=${stats.succeeded}${bonus}${errParts ? ` | errors: ${errParts}` : ""}`,
    )
}


let progressMap = new Map()

async function loadProgress(imageFiles, prompts) {
    try {
        const raw = await fsp.readFile(PROGRESS_FILE, "utf8")
        const obj = JSON.parse(raw)
        progressMap = new Map(Object.entries(obj).map(([k, v]) => [k, Number(v) || 0]))
        return
    } catch {
        // No progress file — seed from filesystem scan (one-time migration)
    }
    progressMap = new Map()
    for (const imageFile of imageFiles) {
        for (const prompt of prompts) {
            const count = countExistingOutputs(imageFile, prompt)
            if (count > 0) progressMap.set(pairFilePrefix(imageFile, prompt), count)
        }
    }
    await flushProgress()
}

async function flushProgress() {
    try {
        await fsp.writeFile(PROGRESS_FILE, JSON.stringify(Object.fromEntries(progressMap), null, 2))
    } catch {
        // best-effort
    }
}

function getProgress(imageFile, prompt) {
    return progressMap.get(pairFilePrefix(imageFile, prompt)) ?? 0
}

function incrementProgress(imageFile, prompt) {
    const key = pairFilePrefix(imageFile, prompt)
    progressMap.set(key, (progressMap.get(key) ?? 0) + 1)
    flushProgress().catch(() => {})
}

// ---------- Per-request attempt (no stats mutation) ----------

// Returns { ok: true } on success or { ok: false, errorCategory } on failure.
// Does NOT mutate global stats — callers handle that.
async function processImageAttempt({ imagePath, imageFile, prompt, requestIndex, filenamePrefix, outputSubDir }) {
    let lastErr = null

    for (let si = 0; si < SERVICES.length; si++) {
        const service = SERVICES[si]

        let retryCount = 0

        while (retryCount < MAX_RETRIES) {
            const serial = service.generateSerial()
            let jobId = null
            let outputUrl = null

            try {
                const createData = await createJob(imagePath, path.basename(imageFile), prompt, serial, service)
                jobId = createData.result.job_id
                console.log(
                    `Accepted job_id=${jobId}${createData.code != null ? ` api=${createData.code}` : ""} — awaiting completion (Progress succeeded = file saved)`,
                )

                outputUrl = await waitForJob(jobId, serial, service)
                if (!outputUrl) throw new Error("No output URL returned")

                const arrayBuffer = await downloadImage(outputUrl)
                const ext = safeOutputExt(outputUrl)

                await fsp.mkdir(outputSubDir, { recursive: true })
                const outputPath = path.join(
                    outputSubDir,
                    `${filenamePrefix}__${Date.now()}_${requestIndex}${ext}`,
                )
                await fsp.writeFile(outputPath, Buffer.from(arrayBuffer))

                await appendOutputLog(`ok serial=${serial} job_id=${jobId}`)
                bumpServiceSuccess(service.name)
                return { ok: true }
            } catch (err) {
                lastErr = err
                if (/^Create rejected /i.test(String(err?.message ?? ""))) {
                    await appendOutputLog(`fail serial=${serial}`).catch(() => {})
                }
                retryCount++

                if (!isRetryable(err)) break

                if (retryCount < MAX_RETRIES) {
                    const jitter = Math.floor(Math.random() * 500)
                    const backoff = 2000 * 2 ** (retryCount - 1) + jitter
                    await sleep(backoff)
                }
            }
        }
    }

    return { ok: false, errorCategory: categorizeError(lastErr) }
}

// ---------- Per-slot processing (fires N concurrent attempts, first success wins) ----------

// Each "slot" represents one needed output image. When FIRE_N_PER_SLOT > 1 we race N
// concurrent requests; the first success satisfies the slot and all other attempts that
// also succeed produce bonus images on disk without double-counting in stats.
async function processPairSlot({ imagePath, imageFile, prompt, slotIndex, filenamePrefix, outputSubDir }) {
    const N = FIRE_N_PER_SLOT

    if (N <= 1) {
        const result = await processImageAttempt({ imagePath, imageFile, prompt, requestIndex: slotIndex, filenamePrefix, outputSubDir })
        if (result.ok) {
            stats.succeeded++
            incrementProgress(imageFile, prompt)
            console.log(`[OK ${stats.succeeded}/${stats.total}] slot=${slotIndex}`)
        } else {
            bumpError(result.errorCategory)
        }
        return result.ok
    }

    // Fire N attempts in parallel; slot succeeds on first win.
    return new Promise((resolve) => {
        let slotDone = false
        let remaining = N

        for (let n = 0; n < N; n++) {
            processImageAttempt({
                imagePath, imageFile, prompt,
                requestIndex: slotIndex * N + n,
                filenamePrefix,
                outputSubDir,
            }).then((result) => {
                remaining--
                if (result.ok && !slotDone) {
                    slotDone = true
                    stats.succeeded++
                    incrementProgress(imageFile, prompt)
                    console.log(`[OK ${stats.succeeded}/${stats.total}] slot=${slotIndex} attempt=${n}/${N}`)
                    resolve(true)
                } else if (remaining === 0 && !slotDone) {
                    bumpError(result.errorCategory)
                    resolve(false)
                }
            }).catch(() => {
                remaining--
                if (remaining === 0 && !slotDone) {
                    bumpError("other")
                    resolve(false)
                }
            })
        }
    })
}

async function runConcurrent(tasks, limit) {
    const results = []
    let index = 0

    async function worker() {
        while (true) {
            const currentIndex = index++
            if (currentIndex >= tasks.length) break
            results[currentIndex] = await tasks[currentIndex]()
        }
    }

    const workers = []
    for (let i = 0; i < limit; i++) workers.push(worker())
    await Promise.all(workers)
    return results
}

// ---------- Tuple selection parser ----------

function range(n) {
    return Array.from({ length: n }, (_, i) => i)
}

function validIdx(s, max, kind) {
    const n = parseInt(s, 10)
    if (!Number.isInteger(n) || n < 0 || n >= max) {
        throw new Error(`Invalid ${kind} index: ${s} (must be 0..${max - 1})`)
    }
    return n
}

function parseSelection(input, imageCount, promptCount) {
    const trimmed = input.trim().toLowerCase()
    if (trimmed === "a" || trimmed === "all") {
        const all = []
        for (let i = 0; i < imageCount; i++) {
            for (let p = 0; p < promptCount; p++) all.push({ imageIndex: i, promptIndex: p })
        }
        return all
    }

    const re = /\(\s*(\d+|\*)\s*,\s*(\d+|\*)\s*\)/g
    const dedup = new Set()
    const out = []
    let m
    while ((m = re.exec(input)) !== null) {
        const imgs = m[1] === "*" ? range(imageCount) : [validIdx(m[1], imageCount, "image")]
        const prms = m[2] === "*" ? range(promptCount) : [validIdx(m[2], promptCount, "prompt")]
        for (const i of imgs) {
            for (const p of prms) {
                const k = `${i}\0${p}`
                if (!dedup.has(k)) {
                    dedup.add(k)
                    out.push({ imageIndex: i, promptIndex: p })
                }
            }
        }
    }

    if (out.length === 0) {
        throw new Error('No valid tuples parsed. Examples: "(0,1) (*,2)" or "a"')
    }
    return out
}

// ---------- CLI argument helpers ----------

function getArgValue(flag) {
    const prefix = `--${flag}=`
    const arg = process.argv.find((a) => a.startsWith(prefix))
    return arg ? arg.slice(prefix.length) : null
}

// Return the sorted list of top-level subdirectory names present among imageFiles.
// Root-level files (no sub-directory) are represented as ".".
function getTopLevelFolders(imageFiles) {
    const seen = new Set()
    for (const f of imageFiles) {
        const slash = f.indexOf("/")
        seen.add(slash === -1 ? "." : f.slice(0, slash))
    }
    return [...seen].sort((a, b) => {
        if (a === ".") return -1
        if (b === ".") return 1
        return a.localeCompare(b)
    })
}

// Filter imageFiles to those inside the given top-level folder ("." = root only).
function filterByFolder(imageFiles, folder) {
    if (folder === "." || folder === "") return imageFiles.filter((f) => !f.includes("/"))
    return imageFiles.filter((f) => f === folder || f.startsWith(folder + "/"))
}

// ---------- main ----------

async function main() {
    if (!fs.existsSync(INPUT_DIR)) throw new Error(`Input folder not found: ${INPUT_DIR}`)
    if (!fs.existsSync(PROMPT_FILE)) throw new Error(`Prompt file not found: ${PROMPT_FILE}`)
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

    if (CONCURRENT_LIMIT > 128) {
        console.warn(
            `[script1] CONCURRENT_LIMIT=${CONCURRENT_LIMIT} is very high; expect API throttling or socket errors. ` +
                "A stable range is usually 12–64 (plain `node script1.js` defaults to 12).\n",
        )
    }

    const prompts = fs
        .readFileSync(PROMPT_FILE, "utf8")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
    if (prompts.length === 0) throw new Error("No prompts found")

    // Recursively scan input — returns relative paths like "image.jpg" or "sub/image.jpg"
    const allImageFiles = scanInputImages(INPUT_DIR)
    if (allImageFiles.length === 0) throw new Error("No images found")

    // ---- Folder picker ----
    const folders = getTopLevelFolders(allImageFiles)
    let imageFiles = allImageFiles

    const folderArg = getArgValue("folder")

    if (folders.length > 1 || (folders.length === 1 && folders[0] !== ".")) {
        console.log("\n========== AVAILABLE FOLDERS ==========\n")
        console.log("[all] All folders")
        folders.forEach((f, i) => console.log(`[${i}]  ${f === "." ? ". (root)" : f}`))
        console.log()

        let folderAnswer = folderArg
        if (!folderAnswer) {
            console.log("Pick a folder by index or name, or press Enter / type 'all' for all.")
            folderAnswer = await askQuestion("folder> ")
        } else {
            console.log(`Using --folder: ${folderArg}`)
        }

        const trimmed = folderAnswer.trim()
        if (trimmed !== "" && trimmed.toLowerCase() !== "all") {
            const byIndex = parseInt(trimmed, 10)
            const selected = (!isNaN(byIndex) && byIndex >= 0 && byIndex < folders.length)
                ? folders[byIndex]
                : trimmed

            const filtered = filterByFolder(allImageFiles, selected)
            if (filtered.length === 0) throw new Error(`No images found in folder: ${selected}`)
            imageFiles = filtered
            console.log(`\nFiltered to folder "${selected}" — ${imageFiles.length} image(s)\n`)
        }
    }

    await loadProgress(allImageFiles, prompts)

    console.log("\n========== AVAILABLE IMAGES ==========\n")
    // imageFiles.forEach((f, i) => console.log(`[${i}] ${f}`))

    console.log("\n========== AVAILABLE PROMPTS ==========\n")
    // prompts.forEach((p, i) => console.log(`[${i}] ${p}`))

    console.log("\nEnter pairs as (img_idx, prompt_idx). Use * for all.")
    console.log("Examples: (0,1)   (*,0)   (0,*) (1,2)   a")
    console.log('Note: "a" / "all" = every prompt in prompt.txt × every image (not the same as (*,0)).')
    console.log("Or pass --command=\"(0,1) (*,2)\" to skip the prompt.")
    console.log('Or: --command=a --prompt-index=0  →  all images, first prompt only.\n')

    // Accept command from CLI arg or interactive prompt
    const commandArg = getArgValue("command")
    const answer = commandArg ?? (await askQuestion("> "))
    if (commandArg) console.log(`Using --command: ${commandArg}`)

    let selection = parseSelection(answer, imageFiles.length, prompts.length)

    const promptIndexArg = getArgValue("prompt-index")
    if (promptIndexArg != null) {
        const pi = parseInt(promptIndexArg, 10)
        if (!Number.isInteger(pi) || pi < 0 || pi >= prompts.length) {
            throw new Error(`Invalid --prompt-index=${promptIndexArg} (use 0..${prompts.length - 1})`)
        }
        const cmdTrim = answer.trim().toLowerCase()
        if (cmdTrim === "a" || cmdTrim === "all") {
            selection = range(imageFiles.length).map((i) => ({ imageIndex: i, promptIndex: pi }))
            console.log(
                `\n--prompt-index=${pi}: using all ${imageFiles.length} image(s) × prompt [${pi}] only (` +
                    `${prompts.length} line(s) in prompt.txt; others skipped).\n`,
            )
        }
    }

    const allPairs = selection.map(({ imageIndex, promptIndex }) => {
        const imageFile = imageFiles[imageIndex]
        const prompt = prompts[promptIndex]
        const existing = getProgress(imageFile, prompt)
        const needed = Math.max(0, MIN_SUCCESS_PER_IMAGE - existing)
        return {
            imageIndex,
            promptIndex,
            imageFile,
            prompt,
            imagePath: path.join(INPUT_DIR, imageFile),
            existing,
            needed,
        }
    })

    const skip = allPairs.filter((p) => p.needed === 0)
    const work = allPairs.filter((p) => p.needed > 0)

    console.log()
    if (skip.length > 0) {
        console.log(`Skipping ${skip.length} pair(s) already at ${MIN_SUCCESS_PER_IMAGE}/${MIN_SUCCESS_PER_IMAGE}`)
    }
    if (work.length === 0) {
        console.log("\nNothing to generate. All selected pairs are already at target.")
        return
    }

    stats.total = work.reduce((s, p) => s + p.needed, 0)
    const fireDesc = FIRE_N_PER_SLOT > 1 ? ` (firing ${FIRE_N_PER_SLOT} concurrent per slot)` : ""
    console.log(`\nFiring ${stats.total} slot(s) with concurrency ${CONCURRENT_LIMIT}${fireDesc}\n`)

    const tasks = []
    let globalIndex = 0
    for (const pair of work) {
        const filenamePrefix = pairFilePrefix(pair.imageFile, pair.prompt)
        // Mirror input sub-folder in output
        const subDir = path.posix.dirname(pair.imageFile)
        const outputSubDir = (!subDir || subDir === ".") ? OUTPUT_DIR : path.join(OUTPUT_DIR, subDir)

        for (let i = 0; i < pair.needed; i++) {
            const slotIndex = globalIndex++
            tasks.push(() =>
                processPairSlot({
                    imagePath: pair.imagePath,
                    imageFile: pair.imageFile,
                    prompt: pair.prompt,
                    slotIndex,
                    filenamePrefix,
                    outputSubDir,
                }),
            )
        }
    }

    const progressTimer = setInterval(printProgress, PROGRESS_INTERVAL_MS)
    try {
        await runConcurrent(tasks, CONCURRENT_LIMIT)
    } finally {
        clearInterval(progressTimer)
    }

    printProgress()

    const underTarget = []
    for (const pair of work) {
        const final = getProgress(pair.imageFile, pair.prompt)
        if (final < MIN_SUCCESS_PER_IMAGE) underTarget.push({ ...pair, final })
    }
    const fullyMet = work.length - underTarget.length
    const totalErrors = Object.values(stats.errors).reduce((a, b) => a + b, 0)

    console.log("\n========== FINAL SUMMARY ==========\n")
    console.log(`Pairs: ${work.length}    fully-met: ${fullyMet}    under-target: ${underTarget.length}`)
    const filesWritten = serviceFilesTotal()
    console.log(`Slots: ${stats.total}   filled: ${stats.succeeded}    failed: ${totalErrors}`)
    console.log(`Files saved (each successful API run that wrote an image): ${filesWritten}`)
    if (filesWritten !== stats.succeeded) {
        console.log(
            `  (filled < files when FIRE_N_PER_SLOT>1: extra parallel winners still save files and increment per-service counts, but only one fill credit per slot.)`,
        )
    }
    console.log("\nFiles per backend:")
    for (const s of SERVICES) {
        console.log(`  ${s.name.padEnd(14)}${stats.byService[s.name] ?? 0}`)
    }
    if (totalErrors > 0) {
        console.log(`\nErrors by category:`)
        Object.entries(stats.errors)
            .sort((a, b) => b[1] - a[1])
            .forEach(([k, v]) => console.log(`  ${k.padEnd(14)}${v}`))
    }
    if (underTarget.length > 0) {
        console.log(`\nUnder-target: ${underTarget.length} pair(s) — rerun the same selection to top them up`)
    }
    console.log("\nAll done.")
}

main().catch((err) => {
    console.error(err.message ?? err)
    process.exit(1)
})
