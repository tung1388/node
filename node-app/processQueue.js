// Script B: drain queue.json.
//
// Every job is checked exactly once per run (no internal poll loop, no retry) via
// lib.js's checkJobOnce. Three outcomes:
//   - "done"     -> download + save + bump progress.json, then always remove from queue.json.
//   - "progress" -> still processing; left in queue.json untouched, check again next run.
//   - error      -> logged; only removed from queue.json if --delete=true is passed. Removing
//                   it is what lets createJobs.js notice the shortfall (progress.json was never
//                   incremented) and create a replacement job next time it runs.
//
// --service=mukeai restricts this run to mukeai-tagged jobs only (they can take a long time,
// so you'd typically run this on its own slower schedule). Without it, mukeai jobs are skipped
// and left untouched — only run them via --service=mukeai.
//
// Usage:
//   node processQueue.js                        (all non-mukeai jobs, failures kept queued)
//   node processQueue.js --delete=true           (same, but failures are removed from the queue)
//   node processQueue.js --service=mukeai [--delete=true]   (mukeai jobs only)
//
// --input=/--output=/--prompt= override the default ./input, ./output, ./prompt.txt locations
// (must match what was passed to createJobs.js for the same run).

import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import {
    CONCURRENT_LIMIT,
    QUEUE_FILE,
    INPUT_DIR,
    PROMPT_FILE,
    findService,
    checkJobOnce,
    downloadImage,
    safeOutputExt,
    loadProgress,
    incrementProgress,
    loadQueue,
    saveQueue,
    runConcurrent,
    appendOutputLog,
    scanInputImages,
    categorizeError,
    getArgValue,
} from "./lib.js"

const MUKEAI_MODE = getArgValue("service") === "mukeai"
const DELETE_FAILED = getArgValue("delete") === "true"

const stats = {
    total: 0,
    saved: 0,
    stillProgress: 0,
    errors: {},
}

function bumpError(category) {
    stats.errors[category] = (stats.errors[category] ?? 0) + 1
}

function printProgress() {
    const failed = Object.values(stats.errors).reduce((a, b) => a + b, 0)
    const done = stats.saved + failed + stats.stillProgress
    const errParts = Object.entries(stats.errors)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
    console.log(
        `[Progress] ${done}/${stats.total} checked | saved=${stats.saved} | still_processing=${stats.stillProgress}${errParts ? ` | errors: ${errParts}` : ""}`,
    )
}

// Entries still unresolved (kept in queue.json in case the process is interrupted, or because
// they're "progress" / not selected by the current --service mode / failed without --delete=true).
let remainingQueue = []

async function persistRemaining() {
    await saveQueue(remainingQueue).catch(() => {})
}

async function removeFromQueue(id) {
    remainingQueue = remainingQueue.filter((e) => e.id !== id)
    await persistRemaining()
}

async function processEntry(entry) {
    const service = findService(entry.serviceName)

    try {
        const result = await checkJobOnce(entry.jobId, entry.serial, service)

        if (result.status === "progress") {
            stats.stillProgress++
            console.log(`[PROGRESS] job_id=${entry.jobId} (${entry.serviceName}) — still processing, left in queue`)
            return true
        }

        const arrayBuffer = await downloadImage(result.url)
        const ext = safeOutputExt(result.url)

        await fsp.mkdir(entry.outputSubDir, { recursive: true })
        const outputPath = path.join(
            entry.outputSubDir,
            `${entry.filenamePrefix}__${Date.now()}_${entry.id.slice(0, 8)}${ext}`,
        )
        await fsp.writeFile(outputPath, Buffer.from(arrayBuffer))

        await appendOutputLog(`ok serial=${entry.serial} job_id=${entry.jobId}`)
        incrementProgress(entry.imageFile, entry.prompt)
        stats.saved++
        console.log(`[SAVED ${stats.saved}] job_id=${entry.jobId} -> ${outputPath}`)

        await removeFromQueue(entry.id) // saved jobs are always removed
        return true
    } catch (err) {
        await appendOutputLog(`fail serial=${entry.serial} job_id=${entry.jobId} err=${err.message}`).catch(() => {})
        bumpError(categorizeError(err))
        console.error(`[FAIL] job_id=${entry.jobId} (${entry.serviceName}): ${err.message}`)

        // lib.js marks definitive, unrecoverable job failures with `permanent: true` (e.g.
        // photoeditorai "timeout_canceled", ezcreate {"detail": "Not Found"} or a non-empty
        // `error` field on any status). Leaving those queued would just repeat the same
        // result forever, so always drop them regardless of --delete=true (this still lets
        // createJobs.js recreate the slot).
        if (DELETE_FAILED || err.permanent) {
            await removeFromQueue(entry.id)
        }
        return false
    }
}

async function main() {
    const queue = await loadQueue()
    if (queue.length === 0) {
        console.log(`No jobs in ${QUEUE_FILE} — nothing to do. Run createJobs.js first.`)
        return
    }

    remainingQueue = [...queue]

    const targetEntries = queue.filter((e) => (MUKEAI_MODE ? e.serviceName === "mukeai" : e.serviceName !== "mukeai"))
    const skippedCount = queue.length - targetEntries.length

    if (targetEntries.length === 0) {
        console.log(
            MUKEAI_MODE
                ? `No mukeai jobs in ${QUEUE_FILE}.`
                : `No non-mukeai jobs in ${QUEUE_FILE} to process.${skippedCount > 0 ? ` (${skippedCount} mukeai job(s) present — run with --service=mukeai to process them.)` : ""}`,
        )
        return
    }

    stats.total = targetEntries.length

    // loadProgress only uses these to seed progress.json from a filesystem scan when
    // progress.json doesn't exist yet — pass the real lists so that fallback stays correct.
    const seedImageFiles = fs.existsSync(INPUT_DIR) ? scanInputImages(INPUT_DIR) : []
    const seedPrompts = fs.existsSync(PROMPT_FILE)
        ? fs.readFileSync(PROMPT_FILE, "utf8").split("\n").map((x) => x.trim()).filter(Boolean)
        : []
    await loadProgress(seedImageFiles, seedPrompts)

    console.log(
        `Checking ${targetEntries.length} queued ${MUKEAI_MODE ? "mukeai " : ""}job(s) once each, concurrency ${CONCURRENT_LIMIT}` +
            (skippedCount > 0 ? ` (${skippedCount} other job(s) left untouched in queue)` : "") +
            ` | --delete=${DELETE_FAILED}\n`,
    )

    const tasks = targetEntries.map((entry) => () => processEntry(entry))

    const progressTimer = setInterval(printProgress, 3000)
    try {
        await runConcurrent(tasks, CONCURRENT_LIMIT)
    } finally {
        clearInterval(progressTimer)
    }

    printProgress()

    const totalErrors = Object.values(stats.errors).reduce((a, b) => a + b, 0)
    console.log("\n========== FINAL SUMMARY ==========\n")
    console.log(`Checked: ${stats.total}   saved: ${stats.saved}   still_processing: ${stats.stillProgress}   failed: ${totalErrors}`)
    if (totalErrors > 0) {
        console.log(`\nErrors by category:`)
        Object.entries(stats.errors)
            .sort((a, b) => b[1] - a[1])
            .forEach(([k, v]) => console.log(`  ${k.padEnd(14)}${v}`))
        if (DELETE_FAILED) {
            console.log(`\n${totalErrors} job(s) failed and were removed from the queue — their progress was never`)
            console.log(`incremented, so the next createJobs.js run will create replacement jobs for them.`)
        } else {
            console.log(`\n${totalErrors} job(s) failed but were left in the queue (pass --delete=true to remove them`)
            console.log(`and let createJobs.js create replacement jobs instead of rechecking the same failure).`)
        }
    }
    if (stats.stillProgress > 0) {
        console.log(`\n${stats.stillProgress} job(s) still processing — left in the queue, rerun later to check again.`)
    }
    console.log("\nAll done.")
}

main().catch((err) => {
    console.error(err.message ?? err)
    process.exit(1)
})
