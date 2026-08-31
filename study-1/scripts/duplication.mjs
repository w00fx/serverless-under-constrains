#!/usr/bin/env node
/* global console, process */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const STUDY1 = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(STUDY1, "..");
const TARGETS = [
  join(STUDY1, "src/protocol-records"),
  join(STUDY1, "src/controlled-provider"),
  join(STUDY1, "src/coordination"),
];
const WINDOW = 12;
const MIN_DUPES = 2;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else if (name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

function tokens(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .split(/[^A-Za-z0-9_]+/)
    .filter((token) => token.length > 0);
}

const files = TARGETS.flatMap((target) => walk(target));
const seen = new Map();
const dupes = [];

for (const file of files) {
  const toks = tokens(readFileSync(file, "utf8"));
  for (let i = 0; i + WINDOW <= toks.length; i += 1) {
    const key = toks.slice(i, i + WINDOW).join(" ");
    const rel = relative(ROOT, file);
    const prev = seen.get(key);
    if (prev && prev !== rel) {
      dupes.push({ key, a: prev, b: rel });
    } else if (!prev) {
      seen.set(key, rel);
    }
  }
}

if (dupes.length >= MIN_DUPES) {
  console.error(`duplication: ${dupes.length} shared ${WINDOW}-token windows`);
  for (const dupe of dupes.slice(0, 8)) {
    console.error(`  ${dupe.a} <> ${dupe.b}: ${dupe.key}`);
  }
  process.exit(1);
}

console.log(
  `duplication: ok (${files.length} files, ${dupes.length} cross-file windows, threshold ${MIN_DUPES})`,
);
