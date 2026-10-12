import { test } from "node:test";
import assert from "node:assert/strict";
import { compileCosmetic, selectorKey } from "./cosmetic.mjs";
import { hostCandidates, pagePlan, selectorsForTokens, toCss } from "../src/cosmetic-lookup.js";

const list = [
  "! comment",
  "##.ad-banner",
  "###sidebar-ad > div",
  "##div[id^='div-gpt-ad']",
  "##.sponsored",
  "news.com##.promo-box",
  "news.com#@#.sponsored",
  "#@#.ad-banner-allowed",
  "##.ad-banner-allowed",
  "shop.com,~help.shop.com##.deal-ad",
  "~quiet.com##.popup-ad",
  "google.*##.g-ad",
  "site.com#?#div:has(> .ad)",
  "site.com#?#div:-abp-contains(Sponsored)",
  "site.com##+js(set, ads, false)",
  "@@||clean.com^$generichide",
  "@@||bare.com^$elemhide",
  "||ads.example.com^",
].join("\n");

const { data, stats } = compileCosmetic([list]);

test("selector keys", () => {
  assert.equal(selectorKey(".ad-banner"), ".ad-banner");
  assert.equal(selectorKey("#sidebar-ad > div"), "#sidebar-ad");
  assert.equal(selectorKey(".a.b"), ".a");
  assert.equal(selectorKey("div.ad"), null);
  assert.equal(selectorKey("[id^='ad']"), null);
  assert.equal(selectorKey(".a, .b"), null);
});

test("compiles generic, specific and exceptions", () => {
  assert.deepEqual(data.generic.keyed[".ad-banner"], [".ad-banner"]);
  assert.deepEqual(data.generic.keyed["#sidebar-ad"], ["#sidebar-ad > div"]);
  assert.deepEqual(data.generic.unkeyed, ["div[id^='div-gpt-ad']"]);
  assert.equal(data.generic.keyed[".ad-banner-allowed"], undefined, "generic exception removes it");
  assert.deepEqual(data.specific["news.com"], [".promo-box"]);
  assert.deepEqual(data.specific["site.com"], ["div:has(> .ad)"]);
  assert.deepEqual(data.genericHide, ["clean.com"]);
  assert.deepEqual(data.elemHide, ["bare.com"]);
  assert.equal(stats.skipped.procedural, 1);
  assert.equal(stats.skipped.scriptlet, 1);
});

test("page plans respect exceptions and switches", () => {
  const news = pagePlan(data, "www.news.com");
  assert.ok(news.selectors.includes(".promo-box"));
  assert.deepEqual(selectorsForTokens(data, [".sponsored"], news), [], "news.com#@#.sponsored");
  assert.deepEqual(selectorsForTokens(data, [".sponsored"], pagePlan(data, "other.com")), [".sponsored"]);

  assert.ok(pagePlan(data, "shop.com").selectors.includes(".deal-ad"));
  assert.ok(!pagePlan(data, "help.shop.com").selectors.includes(".deal-ad"));
  assert.deepEqual(selectorsForTokens(data, [".popup-ad"], pagePlan(data, "quiet.com")), []);

  assert.ok(pagePlan(data, "www.google.co.uk").selectors.includes(".g-ad"));

  const clean = pagePlan(data, "clean.com");
  assert.equal(clean.generic, false);
  assert.ok(!clean.selectors.includes("div[id^='div-gpt-ad']"));
  assert.equal(pagePlan(data, "bare.com"), null);
});

test("host candidates and css", () => {
  assert.ok(hostCandidates("a.b.example.com").includes("example.com"));
  assert.ok(hostCandidates("example.co.uk").includes("example.*"));
  assert.equal(toCss([".a", "#b"]), ".a{display:none!important}\n#b{display:none!important}");
});
