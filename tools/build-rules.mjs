// Builds rules/base.json (a Chrome declarativeNetRequest ruleset) from rules/domains.txt.
// Usage: node tools/build-rules.mjs
// No dependencies, no network access.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "rules", "domains.txt");
const out = join(root, "rules", "base.json");

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

export function toRules(domains) {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const domains = parseDomains(readFileSync(src, "utf8"));
  writeFileSync(out, JSON.stringify(toRules(domains), null, 2) + "\n");
  console.log(`Wrote ${domains.length} rules to rules/base.json`);
}
