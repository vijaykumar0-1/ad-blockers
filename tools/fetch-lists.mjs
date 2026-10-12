// Downloads the filter lists LocalBlock is built from and saves them to lists/*.txt.
//
//   easylist, easyprivacy   assembled from github.com/easylist/easylist, following the
//                           same templates the maintainers use
//   ubo                     uBlock Origin's own filters and quick fixes, from
//                           github.com/uBlockOrigin/uAssets (used for scriptlets)
//
// Usage:
//   node tools/fetch-lists.mjs                    download from GitHub
//   node tools/fetch-lists.mjs --from <dir>       use local clones: <dir>/easylist, <dir>/uAssets
//
// This runs at build time only. The extension itself never downloads anything.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES = {
  easylist: { raw: "https://raw.githubusercontent.com/easylist/easylist/master/", local: "easylist" },
  uassets: { raw: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", local: "uAssets" },
};

export const LISTS = [
  { id: "easylist", source: "easylist", roots: ["easylist.template"] },
  { id: "easyprivacy", source: "easylist", roots: ["easyprivacy.template"] },
  { id: "ubo", source: "uassets", roots: ["filters/filters.txt", "filters/quick-fixes.txt"] },
];

const fromIdx = process.argv.indexOf("--from");
const localDir = fromIdx > 0 ? process.argv[fromIdx + 1] : null;

async function readSource(source, path) {
  const src = SOURCES[source];
  if (localDir) return readFileSync(join(localDir, src.local, path), "utf8");
  const res = await fetch(src.raw + path);
  if (!res.ok) throw new Error(`GET ${src.raw + path} -> HTTP ${res.status}`);
  return res.text();
}

// Follows "%include easylist:path%" (EasyList templates) and "!#include path" (uBlock lists).
async function assemble(source, path, depth = 0) {
  if (depth > 5) throw new Error(`include loop at ${path}`);
  const text = await readSource(source, path);
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const tpl = /^%include easylist:(.+)%$/.exec(line.trim());
    const inc = /^!#include (\S+)/.exec(line.trim());
    if (tpl) {
      out.push(`! ---- ${tpl[1]} ----`, (await readSource(source, tpl[1])).trimEnd());
    } else if (inc) {
      const target = posix.join(posix.dirname(path), inc[1]);
      out.push(`! ---- ${target} ----`, (await assemble(source, target, depth + 1)).trimEnd());
    } else {
      out.push(line);
    }
  }
  return out.join("\n") + "\n";
}

mkdirSync(join(root, "lists"), { recursive: true });
for (const { id, source, roots } of LISTS) {
  const parts = [];
  for (const path of roots) parts.push(await assemble(source, path));
  const text = parts.join("\n").replace("%timestamp%", new Date().toUTCString());
  writeFileSync(join(root, "lists", `${id}.txt`), text);
  console.log(`lists/${id}.txt: ${text.split("\n").length} lines`);
}
