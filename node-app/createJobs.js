// Script A: request job creation from the services. Every accepted job is appended to
// queue.json for processQueue.js to poll and download. This script never polls or downloads —
// it only knows "accepted" vs "rejected".
//
// Usage: node createJobs.js [--folder=x] [--command="(0,1) (*,2)"] [--prompt-index=0]
//        [--input=./face-input] [--output=./face-output] [--prompt=./face-prompt]

import fs from "fs"
import path from "path"
import crypto from "crypto"
import {
    SERVICES,
    INPUT_DIR,
    PROMPT_FILE,
    MAX_RETRIES,
    MIN_SUCCESS_PER_IMAGE,
    CONCURRENT_LIMIT,
    QUEUE_FILE,
    createJob,
    isRetryable,
    categorizeError,
    loadProgress,
    getProgress,
    pairFilePrefix,
    scanInputImages,
    loadQueue,
    saveQueue,
    runConcurrent,
    sleep,
    askQuestion,
    parseSelection,
    getArgValue,
    getTopLevelFolders,
    filterByFolder,
    range,
} from "./lib.js"

// ---------- Stats ----------

const stats = {
    total: 0,
    accepted: 0,
    errors: {},
    byService: Object.fromEntries(SERVICES.map((s) => [s.name, 0])),
}

function bumpError(category) {
    stats.errors[category] = (stats.errors[category] ?? 0) + 1
}

function printProgress() {
    const failed = Object.values(stats.errors).reduce((a, b) => a + b, 0)
    const completed = stats.accepted + failed
    const errParts = Object.entries(stats.errors)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
    console.log(
        `[Progress] ${completed}/${stats.total} attempted | accepted=${stats.accepted}${errParts ? ` | errors: ${errParts}` : ""}`,
    )
}

// ---------- Queue persistence (serialized so concurrent accepts can't race each other) ----------

let queueEntries = []
let writeChain = Promise.resolve()

function persistQueue() {
    writeChain = writeChain.then(() => saveQueue(queueEntries))
    writeChain.catch(() => {})
    return writeChain
}

// ---------- Job creation (tries each service, with retries) ----------

async function createJobWithRetries({ imagePath, imageFile, prompt }) {
    let lastErr = null

    for (let si = 0; si < SERVICES.length; si++) {
        const service = SERVICES[si]
        let retryCount = 0

        while (retryCount < MAX_RETRIES) {
            const serial = service.generateSerial()

            try {
                const createData = await createJob(imagePath, path.basename(imageFile), prompt, serial, service)
                const jobId = createData.result.job_id
                return { ok: true, jobId, serial, serviceName: service.name }
            } catch (err) {
                lastErr = err
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

async function createSlot({ imagePath, imageFile, prompt, filenamePrefix, outputSubDir }) {
    const result = await createJobWithRetries({ imagePath, imageFile, prompt })

    if (result.ok) {
        stats.accepted++
        stats.byService[result.serviceName] = (stats.byService[result.serviceName] ?? 0) + 1
        queueEntries.push({
            id: crypto.randomUUID(),
            imageFile,
            imagePath,
            prompt,
            serviceName: result.serviceName,
            serial: result.serial,
            jobId: result.jobId,
            filenamePrefix,
            outputSubDir,
            createdAt: Date.now(),
        })
        // Persist immediately so a Ctrl+C mid-run doesn't lose already-accepted jobs.
        persistQueue()
        console.log(`[ACCEPTED ${stats.accepted}] job_id=${result.jobId} service=${result.serviceName}`)
    } else {
        bumpError(result.errorCategory)
    }

    return result.ok
}

// ---------- main ----------

async function main() {
    if (!fs.existsSync(INPUT_DIR)) throw new Error(`Input folder not found: ${INPUT_DIR}`)
    if (!fs.existsSync(PROMPT_FILE)) throw new Error(`Prompt file not found: ${PROMPT_FILE}`)

    const prompts = fs
        .readFileSync(PROMPT_FILE, "utf8")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
    if (prompts.length === 0) throw new Error("No prompts found")

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

    // Jobs already sitting in queue.json (created earlier, not yet resolved by processQueue.js)
    // count against the target too, so re-running createJobs.js doesn't over-create.
    const existingQueue = await loadQueue()
    queueEntries.push(...existingQueue)
    const pendingCounts = new Map()
    for (const entry of existingQueue) {
        const key = pairFilePrefix(entry.imageFile, entry.prompt)
        pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1)
    }

    console.log("\nEnter pairs as (img_idx, prompt_idx). Use * for all.")
    console.log("Examples: (0,1)   (*,0)   (0,*) (1,2)   a")
    console.log('Note: "a" / "all" = every prompt in prompt.txt × every image (not the same as (*,0)).')
    console.log("Or pass --command=\"(0,1) (*,2)\" to skip the prompt.")
    console.log('Or: --command=a --prompt-index=0  →  all images, first prompt only.\n')

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
        const key = pairFilePrefix(imageFile, prompt)
        const completed = getProgress(imageFile, prompt)
        const pending = pendingCounts.get(key) ?? 0
        const needed = Math.max(0, MIN_SUCCESS_PER_IMAGE - completed - pending)
        return { imageIndex, promptIndex, imageFile, prompt, imagePath: path.join(INPUT_DIR, imageFile), completed, pending, needed }
    })

    const skip = allPairs.filter((p) => p.needed === 0)
    const work = allPairs.filter((p) => p.needed > 0)

    console.log()
    if (skip.length > 0) {
        console.log(`Skipping ${skip.length} pair(s) already at target (completed + already-queued >= ${MIN_SUCCESS_PER_IMAGE})`)
    }
    if (work.length === 0) {
        console.log("\nNothing to create. All selected pairs already have enough completed/queued jobs.")
        return
    }

    stats.total = work.reduce((s, p) => s + p.needed, 0)
    console.log(`\nCreating ${stats.total} job(s) with concurrency ${CONCURRENT_LIMIT}\n`)

    const tasks = []
    for (const pair of work) {
        const filenamePrefix = pairFilePrefix(pair.imageFile, pair.prompt)
        const subDir = path.posix.dirname(pair.imageFile)
        const outputSubDir = (!subDir || subDir === ".") ? "./output" : path.join("./output", subDir)

        for (let i = 0; i < pair.needed; i++) {
            tasks.push(() =>
                createSlot({ imagePath: pair.imagePath, imageFile: pair.imageFile, prompt: pair.prompt, filenamePrefix, outputSubDir }),
            )
        }
    }

    const progressTimer = setInterval(printProgress, 3000)
    try {
        await runConcurrent(tasks, CONCURRENT_LIMIT)
    } finally {
        clearInterval(progressTimer)
    }

    // Every accepted job was already persisted as it came in; flush the final write.
    await persistQueue()

    printProgress()

    const totalErrors = Object.values(stats.errors).reduce((a, b) => a + b, 0)
    console.log("\n========== FINAL SUMMARY ==========\n")
    console.log(`Attempted: ${stats.total}   accepted: ${stats.accepted}   rejected: ${totalErrors}`)
    console.log("\nAccepted per backend:")
    for (const s of SERVICES) {
        console.log(`  ${s.name.padEnd(14)}${stats.byService[s.name] ?? 0}`)
    }
    if (totalErrors > 0) {
        console.log(`\nErrors by category:`)
        Object.entries(stats.errors)
            .sort((a, b) => b[1] - a[1])
            .forEach(([k, v]) => console.log(`  ${k.padEnd(14)}${v}`))
    }
    console.log(`\n${queueEntries.length} job(s) now in ${QUEUE_FILE} — run processQueue.js next.`)
    console.log("\nAll done.")
}

process.on("SIGINT", async () => {
    console.log(`\n\nInterrupted — ${stats.accepted} accepted job(s) already saved to ${QUEUE_FILE}.`)
    console.log("Waiting for last write to flush...")
    try {
        await writeChain
    } catch {
        // saveQueue failure already implies nothing new to flush
    }
    console.log(`${queueEntries.length} job(s) total in ${QUEUE_FILE}.`)
    process.exit(130)
})

main().catch((err) => {
    console.error(err.message ?? err)
    process.exit(1)
})
