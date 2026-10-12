// Run with: node --test tools/
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertFilter, convertList, lineKind, validateRule } from "./abp2dnr.mjs";

const rule = (line) => convertFilter(line).rule;
const skip = (line) => convertFilter(line).skip;

test("line kinds", () => {
  assert.equal(lineKind("! comment"), "comment");
  assert.equal(lineKind("[Adblock Plus 2.0]"), "comment");
  assert.equal(lineKind("example.com##.ad"), "cosmetic");
  assert.equal(lineKind("example.com#@#.ad"), "cosmetic");
  assert.equal(lineKind("example.com#?#div:has(.ad)"), "cosmetic");
  assert.equal(lineKind("||ads.example.com^"), "network");
});

test("domain anchor becomes requestDomains", () => {
  assert.deepEqual(rule("||ads.example.com^"), {
    priority: 1,
    action: { type: "block" },
    condition: { requestDomains: ["ads.example.com"] },
  });
});

test("path patterns become urlFilter", () => {
  assert.equal(rule("||example.com/ads/*").condition.urlFilter, "||example.com/ads/");
  assert.equal(rule("/banner/ad_").condition.urlFilter, "/banner/ad_");
  assert.equal(rule("|https://x.com/ad^").condition.urlFilter, "|https://x.com/ad^");
});

test("resource types and party", () => {
  const r = rule("||tracker.com^$script,image,third-party");
  assert.deepEqual(r.condition.resourceTypes, ["script", "image"]);
  assert.equal(r.condition.domainType, "thirdParty");
  assert.equal(rule("||x.com^$~third-party").condition.domainType, "firstParty");
  assert.equal(rule("||x.com^$1p").condition.domainType, "firstParty");
  assert.deepEqual(rule("||x.com^$subdocument").condition.resourceTypes, ["sub_frame"]);
});

test("negated types exclude, and never match the page itself", () => {
  assert.deepEqual(rule("/ad.cgi?$~xmlhttprequest").condition.excludedResourceTypes, [
    "main_frame",
    "xmlhttprequest",
  ]);
});

test("domain= option", () => {
  const r = rule("/ads.js$domain=a.com|~b.a.com");
  assert.deepEqual(r.condition.initiatorDomains, ["a.com"]);
  assert.deepEqual(r.condition.excludedInitiatorDomains, ["b.a.com"]);
  assert.equal(skip("/ads.js$domain=example.*"), "domain-syntax");
});

test("exceptions outrank blocks; important outranks exceptions", () => {
  const allow = rule("@@||cdn.example.com/ads.js");
  assert.equal(allow.action.type, "allow");
  assert.ok(allow.priority > rule("||example.com^").priority);
  assert.ok(rule("||example.com^$important").priority > allow.priority);
});

test("$document blocks the page itself (redirect targets)", () => {
  assert.deepEqual(rule("||adpage.example^$document"), {
    priority: 1,
    action: { type: "block" },
    condition: { requestDomains: ["adpage.example"], resourceTypes: ["main_frame", "sub_frame"] },
  });
});

test("@@ $document allows the whole page", () => {
  assert.deepEqual(rule("@@||site.com^$document"), {
    priority: 2,
    action: { type: "allowAllRequests" },
    condition: { requestDomains: ["site.com"], resourceTypes: ["main_frame", "sub_frame"] },
  });
});

test("unsupported filters are skipped, never broadened", () => {
  assert.equal(skip("/^https?:\\/\\/ad[0-9]+\\./$script"), "regex");
  assert.equal(skip("||x.com^$popup"), "option:popup");
  assert.equal(skip("||x.com^$csp=script-src 'none'"), "option:csp");
  assert.equal(skip("||x.com^$redirect=noopjs"), "option:redirect");
  assert.equal(skip("||x.com^$unknownoption"), "option:unknownoption");
  assert.equal(skip("*$script"), "matches-everything");
  assert.equal(skip("/addyn|*;adtech;"), "pipe-in-middle");
});

test("convertList merges domain rules and assigns valid ids", () => {
  const text = [
    "[Adblock Plus 2.0]",
    "! comment",
    "||a.com^",
    "||b.com^",
    "||a.com^",
    "||c.com^$third-party",
    "/ads/banner.",
    "example.com##.ad",
  ].join("\n");
  const { rules, cosmetic, stats } = convertList(text);
  assert.equal(stats.network, 5);
  assert.equal(stats.cosmetic, 1);
  assert.deepEqual(cosmetic, ["example.com##.ad"]);
  const merged = rules.find((r) => r.condition.requestDomains?.includes("a.com"));
  assert.deepEqual(merged.condition.requestDomains, ["a.com", "b.com"]);
  assert.deepEqual(rules.map((r) => r.id), [1, 2, 3]);
  for (const r of rules) assert.equal(validateRule(r), null);
});
