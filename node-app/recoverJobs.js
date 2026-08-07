// TEMP / throwaway: re-poll a hardcoded list of job_ids that failed with "fetch failed"
// (transient network blip, not a real job failure) and download them if they're actually done.
// Looks up each job_id's serial from outputs.log ("fail serial=X job_id=Y ...").
// Delete this file once you're done with it.

import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import { findService, checkJobOnce, downloadImage, safeOutputExt, sleep } from "./lib.js"

const JOB_IDS = `
ychngdxwtnrn80czbg2bc2ntq4
j8q1w28fbhrnc0czbg2rggdb38
kkvj24z3w1rn80czbg2bjkkndr
jmye1k5vs5rmt0czbg2anypekw
3ewgqq767nrnc0czbg192y00yr
xaa83kxwqdrnc0czbg298b6bmr
vcnkqgf54srmy0czbg1be2sepg
tgzpknz1nxrmr0czbg28f3thxm
bxx3xqf2rdrnc0czbg290wey1w
k4s0w9jfghrmy0czbg2ben7n9m
tzh1et2g19rp60czbg286na578
dha9z8rf09rmr0czbg2sh4yef8
6vef2xtfe1rp20czbg2b6ntbg8
5drpahmcyhrmr0czbg2bxjvjpm
6c4kgtrc7srmt0czbg2syqz1tc
ptthc2tf4nrmw0czbg2a5bwbeg
pb49vjaessrmr0czbg2ahtzzxg
v86vyx0yc1rmy0czbg2ahdeazw
f13d5r0p81rmt0czbg2apt9rtm
62qfavgvkdrnc0czbg2857qs74
d4f7d30nfxrnc0czbg2aykv9dr
redq2f8pqdrmw0czbg28feqsew
gzqvfpgp9drnc0czbg29r5dqjg
0dswe68mpdrn80czbg29wz7jyg
p8ktnamhdhrp40czbg2axh17q0
2snjfyz4wsrn80czbg1ta4x60m
6y5xj6z521rmr0czbg1v15tkgc
80dwjp4ek5rmy0czbg2anvbz5g
ccqce0z4gdrnc0czbg1vf2e8d4
95tnnqyzv9rmt0czbg1sgxs1gm
n47pebxsmhrn80czbg2bp674pr
wxtqgz6ym1rmt0czbg1s3egbf4
5mg5yrcf59rp20czbg28174ft0
axdcqdywkdrn80czbg1r2spzyg
nn568kx711rn80czbg1v162sq4
wfxnsn4f2drmt0czbg28402g9w
pqbpsm5329rnc0czbg1r9nqw18
yz65teakmxrp40czbg2a58saw0
w9yzrewfghrp00czbg2b0d0ek4
277nv6bkhdrmw0czbg1syfgzqw
svchmjmbknrp40czbg2as58ny0
fkwt5wbg39rn80czbg1r1byr0c
pgb15771ddrn80czbg28131s18
0bshgexwtxrmy0czbg29c888hm
m662p2sh6nrn80czbg1tvpkgv8
dpaesr1dvhrmw0czbg1vb71adg
yq3gk0wddxrmy0czbg297v4e5m
6mwyxv1cbdrmw0czbg1tgzrbqg
`.trim().split("\n").map((s) => s.trim()).filter(Boolean)

const RECOVERED_DIR = "./recovered"
const SERVICE = findService("photoeditor")

function findSerial(jobId) {
    const log = fs.readFileSync("./outputs.log", "utf8")
    const re = new RegExp(`serial=(\\S+) job_id=${jobId}\\b`)
    let match = null
    for (const line of log.split("\n")) {
        const m = line.match(re)
        if (m) match = m[1] // keep last occurrence (most recent attempt)
    }
    return match
}

async function main() {
    await fsp.mkdir(RECOVERED_DIR, { recursive: true })

    let saved = 0
    let failed = 0
    let noSerial = 0

    for (const jobId of JOB_IDS) {
        const serial = findSerial(jobId)
        if (!serial) {
            console.log(`[NO SERIAL] ${jobId} — not found in outputs.log, skipping`)
            noSerial++
            continue
        }

        try {
            let outputUrl = null
            for (let attempt = 0; attempt < 20 && !outputUrl; attempt++) {
                const result = await checkJobOnce(jobId, serial, SERVICE)
                if (result.status === "done") outputUrl = result.url
                else await sleep(3000)
            }
            if (!outputUrl) throw new Error("still processing after retries, try again later")

            const arrayBuffer = await downloadImage(outputUrl)
            const ext = safeOutputExt(outputUrl)
            const outPath = path.join(RECOVERED_DIR, `${jobId}${ext}`)
            await fsp.writeFile(outPath, Buffer.from(arrayBuffer))
            console.log(`[SAVED] ${jobId} -> ${outPath}`)
            saved++
        } catch (err) {
            console.log(`[FAIL] ${jobId}: ${err.message}`)
            failed++
        }
    }

    console.log(`\nDone. saved=${saved} failed=${failed} no_serial=${noSerial} (of ${JOB_IDS.length})`)
}

main().catch((err) => {
    console.error(err.message ?? err)
    process.exit(1)
})
