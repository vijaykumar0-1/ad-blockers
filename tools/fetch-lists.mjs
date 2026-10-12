// Downloads EasyList and EasyPrivacy and assembles them into lists/*.txt.
//
// The lists are built from their source files in the official EasyList repository
// (github.com/easylist/easylist), following the same templates the maintainers use.
//
// Usage:
//   node tools/fetch-lists.mjs                    download from GitHub
//   node tools/fetch-lists.mjs --from <checkout>  use a local clone of easylist/easylist
//
// This runs at build time only. The extension itself never downloads anything.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = "https://raw.githubusercontent.com/easylist/easylist/master/";

export const LISTS = [
  { id: "easylist", template: "easylist.template" },
  { id: "easyprivacy", template: "easyprivacy.template" },
];

const fromIdx = process.argv.indexOf("--from");
const localDir = fromIdx > 0 ? process.argv[fromIdx + 1] : null;

async function readSource(path) {
  if (localDir) return readFileSync(join(localDir, path), "utf8");
  const res = await fetch(RAW + path);
  if (!res.ok) throw new Error(`GET ${RAW + path} -> HTTP ${res.status}`);
  return res.text();
}

async function assemble(templatePath) {
  const template = await readSource(templatePath);
  const out = [];
  for (const line of template.split(/\r?\n/)) {
    const m = /^%include easylist:(.+)%$/.exec(line.trim());
    if (!m) {
      out.push(line);
      continue;
    }
    out.push(`! ---- ${m[1]} ----`);
    out.push((await readSource(m[1])).trimEnd());
  }
  return out.join("\n") + "\n";
}

mkdirSync(join(root, "lists"), { recursive: true });
for (const { id, template } of LISTS) {
  const text = await assemble(template);
  const stamped = text.replace("%timestamp%", new Date().toUTCString());
  writeFileSync(join(root, "lists", `${id}.txt`), stamped);
  console.log(`lists/${id}.txt: ${stamped.split("\n").length} lines`);
}
