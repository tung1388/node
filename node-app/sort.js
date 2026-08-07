#!/usr/bin/env node
'use strict';

/*
 * Copy selected images without opening or decoding them.
 *
 * Examples:
 *   node sort.js --pair 1:0 --pair 2:3
 *   node sort.js --pairs "1:0,2:3" --input ./compressed --output ./sort
 *   node sort.js --pairs "10:*,*:3,1->2:3,3:19->50"
 *   node sort.js --prompt ./my-prompts.txt
 *
 * A pair is "folderNumber:promptIndex".  folderNumber comes from the numbered
 * list shown by the script. promptIndex selects a line in the prompt file;
 * images are copied only when their filename contains that prompt's SHA-1 hash.
 * The source file is copied to <output>/<subfolder>/ with its original name.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'
]);

function usage(exitCode = 0) {
  console.log(`Usage: node sort.js [options]

Options:
  --input=DIR           Source root (default: ./compressed)
  --output=DIR          Destination root (default: ./sort)
  --prompt=FILE         One prompt per line (default: ./prompt.txt)
  --pair=SELECTION      A selection; may be supplied repeatedly
  --pairs=LIST          Comma-separated selections, e.g. 1:0,2:12
  --index-base=0|1      Interpret indices as zero- or one-based (default: 0)
  --concurrency=N       Number of simultaneous copies (default: 16)
  --dry-run             Show what would be copied without writing files
  --help                Show this help

If no --pair or --pairs is provided, folders and numbered prompts are shown,
then you can enter pairs interactively.

Selection forms (ranges are inclusive):
  10:*       every prompt in folder 10
  *:3        prompt 3 in every folder
  1->2:3     prompt 3 in folders 1 through 2
  3:19->50  prompts 19 through 50 in folder 3
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    input: './compressed',
    output: './sort',
    prompt: './prompt.txt',
    pairs: [],
    indexBase: 0,
    concurrency: 16,
    dryRun: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage();
    if (arg === '--dry-run') { options.dryRun = true; continue; }

    const [key, inlineValue] = arg.split(/=(.*)/s, 2);
    // Also tolerate --output==DIR, as sometimes written in shell examples.
    const value = inlineValue === undefined ? argv[++i] : inlineValue.replace(/^=/, '');
    if (!value || !key.startsWith('--')) throw new Error(`Invalid option: ${arg}`);

    if (key === '--input') options.input = value;
    else if (key === '--output') options.output = value;
    else if (key === '--prompt') options.prompt = value;
    else if (key === '--pair') options.pairs.push(value);
    else if (key === '--pairs') options.pairs.push(...value.split(',').filter(Boolean));
    else if (key === '--index-base') options.indexBase = Number(value);
    else if (key === '--concurrency') options.concurrency = Number(value);
    else throw new Error(`Unknown option: ${key}`);
  }

  if (options.indexBase !== 0 && options.indexBase !== 1) throw new Error('--index-base must be 0 or 1.');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer.');
  }
  return options;
}

function selectedFolders(value, folders) {
  if (value === '*') return folders;
  const range = /^(\d+)->(\d+)$/.exec(value);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start < 1 || end < start || end > folders.length) {
      throw new Error(`Invalid folder range "${value}".`);
    }
    return folders.slice(start - 1, end);
  }

  const folderNumber = /^\d+$/.test(value) ? Number(value) : null;
  const folder = folderNumber === null ? value : folders[folderNumber - 1];
  if (!folder) throw new Error(`No folder numbered ${value}.`);
  return [folder];
}

function selectedPromptIndices(value, indexBase, promptCount) {
  if (value === '*') return Array.from({ length: promptCount }, (_, index) => index);
  const range = /^(\d+)->(\d+)$/.exec(value);
  const values = range ? [Number(range[1]), Number(range[2])] : /^\d+$/.test(value) ? [Number(value), Number(value)] : null;
  if (!values) throw new Error(`Invalid prompt selection "${value}".`);
  const [start, end] = values.map((number) => number - indexBase);
  if (start < 0 || end < start || end >= promptCount) {
    throw new Error(`Invalid prompt range "${value}" for the prompt file.`);
  }
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

async function expandPair(value, options, folders, promptCount) {
  const match = /^(.*):(.*)$/.exec(value);
  if (!match || !match[1] || !match[2]) throw new Error(`Invalid selection "${value}".`);
  const targetFolders = selectedFolders(match[1], folders);
  const promptIndices = selectedPromptIndices(match[2], options.indexBase, promptCount);
  const jobs = [];

  for (const folder of targetFolders) {
    for (const promptIndex of promptIndices) jobs.push({ folder, promptIndex });
  }
  return jobs;
}

function childPath(root, relative) {
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(resolvedRoot, relative);
  if (resolvedChild !== resolvedRoot && !resolvedChild.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Folder must stay inside the input directory: ${relative}`);
  }
  return resolvedChild;
}

async function imagesIn(folder) {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function cachedImages(folder, cache) {
  if (!cache.has(folder)) cache.set(folder, imagesIn(folder));
  return cache.get(folder);
}

function promptHash(prompt) {
  return crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 8);
}

async function matchedImages(folder, promptIndices, prompts, imageCache) {
  const files = await cachedImages(folder, imageCache);
  const selections = [...new Set(promptIndices)].map((promptIndex) => ({
    promptIndex,
    hash: promptHash(prompts[promptIndex] ?? '')
  }));
  const found = new Set();
  const matches = [];

  for (const file of files) {
    const name = file.toLowerCase();
    for (const { promptIndex, hash } of selections) {
      // Existing scripts write ...__slug_HASH__timestamp.ext (or __HASH__).
      if (name.includes(`_${hash}__`) || name.includes(`__${hash}__`)) {
        found.add(promptIndex);
        matches.push({ file, promptIndex });
      }
    }
  }

  for (const { promptIndex } of selections) {
    if (!found.has(promptIndex)) {
      console.warn(`No filename hash match for prompt ${promptIndex} in ${path.basename(folder)}.`);
    }
  }
  return matches;
}

async function promptsIn(promptFile) {
  const text = await fs.readFile(promptFile, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop(); // Ignore only the usual final newline.
  return lines;
}

async function foldersIn(input) {
  const entries = await fs.readdir(input, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

async function showChoices(input, promptFile, indexBase) {
  const [folders, prompts] = await Promise.all([foldersIn(input), promptsIn(promptFile)]);

  console.log('Folders:');
  for (const [index, folder] of folders.entries()) console.log(`  ${index + 1}: ${folder}`);
  console.log('\nPrompts:');
  for (const [index, prompt] of prompts.entries()) {
    console.log(`  ${index + indexBase}: ${prompt}`);
  }
  console.log('\nCopy example: --pair=FOLDER_NUMBER:PROMPT_INDEX');
  return folders;
}

async function interactivePairs() {
  if (!process.stdin.isTTY) return [];
  const readline = require('node:readline/promises');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question('Pairs to copy (for example, 1:0 2:3; blank to exit): ');
  terminal.close();
  return answer.split(/[\s,]+/).filter(Boolean);
}

async function copyInParallel(jobs, concurrency, copyJob) {
  let nextJob = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob];
      nextJob += 1;
      await copyJob(job);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let folders;
  if (!options.pairs.length) {
    folders = await showChoices(options.input, options.prompt, options.indexBase);
    options.pairs = await interactivePairs();
    if (!options.pairs.length) return;
  }
  folders ??= await foldersIn(options.input);
  const prompts = await promptsIn(options.prompt);
  const imageCache = new Map();
  const expandedJobs = (await Promise.all(
    options.pairs.map((pair) => expandPair(pair, options, folders, prompts.length))
  )).flat();
  const selectionsByFolder = new Map();
  for (const { folder, promptIndex } of expandedJobs) {
    if (!selectionsByFolder.has(folder)) selectionsByFolder.set(folder, []);
    selectionsByFolder.get(folder).push(promptIndex);
  }

  const matchingJobs = [];
  for (const [folder, promptIndices] of selectionsByFolder) {
    const sourceFolder = childPath(options.input, folder);
    const matches = await matchedImages(sourceFolder, promptIndices, prompts, imageCache);
    for (const { file, promptIndex } of matches) matchingJobs.push({ folder, file, promptIndex });
  }
  const jobs = [...new Map(matchingJobs.map((job) => [`${job.folder}\0${job.file}`, job])).values()];

  // A selected folder is a fresh result set. Clear it once before copying so a
  // later run such as 3:5 replaces results from an earlier run such as 3:3.
  for (const folder of selectionsByFolder.keys()) {
    const destinationFolder = childPath(options.output, folder);
    console.log(`${options.dryRun ? 'Would clear' : 'Clearing'} ${destinationFolder}`);
    if (!options.dryRun) {
      await fs.rm(destinationFolder, { recursive: true, force: true });
      await fs.mkdir(destinationFolder, { recursive: true });
    }
  }

  await copyInParallel(jobs, options.concurrency, async ({ folder, file }) => {
    const sourceFolder = childPath(options.input, folder);
    const source = path.join(sourceFolder, file);
    const destinationFolder = childPath(options.output, folder);
    const destination = path.join(destinationFolder, file);
    console.log(`${options.dryRun ? 'Would copy' : 'Copying'} ${source} -> ${destination}`);
    if (!options.dryRun) {
      await fs.copyFile(source, destination);
    }
  });
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
