// Builds the extension's declarativeNetRequest rulesets.
//
//   rules/base.json         from rules/domains.txt (LocalBlock's own short list)
//   rules/easylist.json     from lists/easylist.txt     (run tools/fetch-lists.mjs first)
//   rules/easyprivacy.json  from lists/easyprivacy.txt
//
// Cosmetic (##) filters are saved to rules/<list>.cosmetic.txt for the cosmetic-filtering
// feature. Usage: node tools/build-rules.mjs
// No dependencies, no network access.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertList, validateRule } from "./abp2dnr.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Chrome guarantees each extension at least this many enabled static rules.
const GUARANTEED_STATIC_RULES = 30000;
const MAX_REGEX_RULES = 1000;

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function parseDomains(text) {
  const seen = new Set();
  const domains = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith("#")) return;
    if (!DOMAIN_RE.test(line)) {
      throw new Error(`domains.txt line ${i + 1}: not a valid domain: "${raw.trim()}"`);
    }
    if (!seen.has(line)) {
      seen.add(line);
      domains.push(line);
    }
  });
  return domains;
}

export function baseRules(domains) {
  return domains.map((domain, i) => ({
    id: i + 1,
    priority: 1,
    action: { type: "block" },
    condition: {
      requestDomains: [domain],
      domainType: "thirdParty",
      excludedResourceTypes: ["main_frame"],
    },
  }));
}

function write(name, rules) {
  for (const rule of rules) {
    const problem = validateRule(rule);
    if (problem) throw new Error(`${name} rule ${rule.id}: ${problem}\n${JSON.stringify(rule)}`);
  }
  // One rule per line keeps diffs readable and the file compact.
  const body = "[\n" + rules.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n";
  writeFileSync(join(root, "rules", `${name}.json`), body);
  return rules.length;
}

function main() {
  let total = 0;

  const base = baseRules(parseDomains(readFileSync(join(root, "rules", "domains.txt"), "utf8")));
  total += write("base", base);
  console.log(`base         ${base.length} rules`);

  for (const id of ["easylist", "easyprivacy"]) {
    const src = join(root, "lists", `${id}.txt`);
    if (!existsSync(src)) {
      console.log(`${id.padEnd(12)} skipped (run: node tools/fetch-lists.mjs)`);
      continue;
    }
    const { rules, cosmetic, stats } = convertList(readFileSync(src, "utf8"));
    total += write(id, rules);
    writeFileSync(join(root, "rules", `${id}.cosmetic.txt`), cosmetic.join("\n") + "\n");
    const skipped = Object.values(stats.skipped).reduce((a, b) => a + b, 0);
    const top = Object.entries(stats.skipped)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    console.log(
      `${id.padEnd(12)} ${rules.length} rules from ${stats.converted} of ${stats.network} network filters ` +
        `(${skipped} skipped: ${top}); ${stats.cosmetic} cosmetic filters saved`
    );
  }

  console.log(`total        ${total} rules (Chrome guarantees ${GUARANTEED_STATIC_RULES})`);
  if (total > GUARANTEED_STATIC_RULES) {
    console.warn("warning: above Chrome's guaranteed minimum; may not all load if other extensions use the shared pool");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
export { MAX_REGEX_RULES };
