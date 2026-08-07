// Compress generated output images using ffmpeg and mirror the folder structure
// into the compress directory.
//
// Usage:
//   node compress.js
//
// Controlled by .env (or shell env vars):
//   COMPRESS_ENABLED=true       — must be true or the script exits early
//   COMPRESS_INPUT_DIR=./output — source directory (default: ./output)
//   COMPRESS_OUTPUT_DIR=./compressed — destination directory
//   COMPRESS_QUALITY=2          — ffmpeg -q:v value (2=very high, 31=low)
//   COMPRESS_CONCURRENT=4       — parallel ffmpeg workers

import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

const COMPRESS_ENABLED = (process.env.COMPRESS_ENABLED ?? "false").toLowerCase() === "true"
const INPUT_DIR = process.env.COMPRESS_INPUT_DIR ?? "./output"
const OUTPUT_DIR = process.env.COMPRESS_OUTPUT_DIR ?? "./compressed"
const QUALITY = Number(process.env.COMPRESS_QUALITY ?? 2)
const CONCURRENT = Number(process.env.COMPRESS_CONCURRENT ?? 4)

const SUPPORTED_EXT = new Set([".png", ".webp", ".jpg", ".jpeg", ".bmp", ".tiff", ".gif"])

if (!COMPRESS_ENABLED) {
    console.log("COMPRESS_ENABLED is not set to true — skipping compression.")
    process.exit(0)
}

function scanImages(dir, baseDir) {
    baseDir = baseDir ?? dir
    const results = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            results.push(...scanImages(fullPath, baseDir))
        } else if (SUPPORTED_EXT.has(path.extname(entry.name).toLowerCase())) {
            results.push({ full: fullPath, relative: path.relative(baseDir, fullPath) })
        }
    }
    return results
}

async function compressImage(inputFile, outputFile) {
    await fsp.mkdir(path.dirname(outputFile), { recursive: true })
    await execFileAsync("ffmpeg", ["-y", "-i", inputFile, "-q:v", String(QUALITY), outputFile])
}

async function runConcurrent(tasks, limit) {
    let index = 0
    async function worker() {
        while (true) {
            const i = index++
            if (i >= tasks.length) break
            await tasks[i]()
        }
    }
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker())
    await Promise.all(workers)
}

async function main() {
    if (!fs.existsSync(INPUT_DIR)) {
        throw new Error(`Input directory not found: ${INPUT_DIR}`)
    }

    const images = scanImages(INPUT_DIR)
    if (images.length === 0) {
        console.log("No images found in", INPUT_DIR)
        return
    }

    console.log(`Found ${images.length} image(s) in ${INPUT_DIR}`)
    console.log(`Compressing to ${OUTPUT_DIR} (quality=${QUALITY}, concurrency=${CONCURRENT})\n`)

    let done = 0
    let failed = 0

    let skipped = 0

    const tasks = images.map(({ full, relative }) => async () => {
        const outputRelative = path.join(
            path.dirname(relative),
            path.parse(relative).name + ".jpg",
        )
        const outputFile = path.join(OUTPUT_DIR, outputRelative)

        if (fs.existsSync(outputFile)) {
            skipped++
            return
        }

        try {
            await compressImage(full, outputFile)
            done++
            if (done % 10 === 0 || done === images.length) {
                console.log(`[${done}/${images.length}] done, ${skipped} skipped, ${failed} failed`)
            }
        } catch (err) {
            failed++
            console.error(`[FAIL] ${relative}: ${err.message}`)
        }
    })

    await runConcurrent(tasks, CONCURRENT)

    console.log(`\nAll done. ${done} compressed, ${skipped} skipped (already exist), ${failed} failed.`)
}

main().catch((err) => {
    console.error(err.message ?? err)
    process.exit(1)
})
