// Zip ./input + ./compressed into final.zip, then SCP it to a22:~/storage/downloads

import { spawn } from "child_process"
import fs from "fs"

const ZIP_FILE = "./final.zip"
const SCP_DEST = "a22:~/storage/downloads"
const SOURCES = ["./input", "./compressed"]

function run(cmd, args, { label = cmd, inheritStdio = false } = {}) {
    return new Promise((resolve, reject) => {
        console.log(`[${label}] ${cmd} ${args.join(" ")}`)

        const proc = spawn(cmd, args, {
            stdio: inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
            shell: false,
        })

        let stdout = ""
        let stderr = ""

        if (!inheritStdio) {
            proc.stdout.on("data", (d) => { stdout += d })
            proc.stderr.on("data", (d) => {
                stderr += d
                // Print SSH/SCP stderr lines immediately so errors are visible in real time
                process.stderr.write(`[${label}] ${d}`)
            })
        }

        proc.on("error", (err) => reject(new Error(`[${label}] Failed to start: ${err.message}`)))
        proc.on("close", (code) => {
            if (code === 0) {
                resolve({ stdout, stderr })
            } else {
                const msg = stderr.trim() || stdout.trim() || `exited with code ${code}`
                reject(new Error(`[${label}] Error (code ${code}): ${msg}`))
            }
        })
    })
}

async function zip() {
    // Check sources exist
    for (const src of SOURCES) {
        if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`)
    }

    // Remove old zip if present
    if (fs.existsSync(ZIP_FILE)) {
        fs.rmSync(ZIP_FILE)
        console.log(`[zip] Removed old ${ZIP_FILE}`)
    }

    // -mx=1 = fastest compression; use -mx=0 for store-only (no compression, fastest of all)
    await run("C:\\Program Files\\7-Zip\\7z.exe", ["a", "-mx=1", ZIP_FILE, ...SOURCES], { label: "zip", inheritStdio: true })

    const size = (fs.statSync(ZIP_FILE).size / 1024 / 1024).toFixed(2)
    console.log(`[zip] Created ${ZIP_FILE} (${size} MB)`)
}

async function send() {
    // scp -r final.zip a22:~/storage/downloads
    await run("scp", ["-r", ZIP_FILE, SCP_DEST], { label: "scp" })
    console.log(`[scp] Uploaded ${ZIP_FILE} -> ${SCP_DEST}`)
}

async function main() {
    console.log("=== Step 1: Zip ===")
    await zip()

    console.log("\n=== Step 2: Send ===")
    await send()

    console.log("\nDone.")
}

main().catch((err) => {
    console.error(`\nFailed: ${err.message}`)
    process.exit(1)
})
