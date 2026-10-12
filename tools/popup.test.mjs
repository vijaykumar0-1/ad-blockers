import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePopups } from "./popup.mjs";
import { isAdPopup, patternToRegExp } from "../src/popup-match.js";

const list = [
  "||popads.example^$popup",
  "||clickfarm.example^$popup,third-party",
  "/go/offer?$popup,domain=streamsite.example",
  "||adserver.example/redirect/*$popup",
  "@@||adserver.example/redirect/legit$popup",
  "||ads.example^$script", // not a popup filter
].join("\n");
const { data } = compilePopups([list]);

test("compiles popup filters", () => {
  assert.deepEqual(data.domains, ["popads.example"]);
  assert.equal(data.rules.length, 3);
  assert.equal(data.exceptions.length, 1);
});

test("pattern to regexp", () => {
  const re = patternToRegExp("||adserver.example/redirect/*");
  assert.ok(re.test("https://adserver.example/redirect/abc"));
  assert.ok(re.test("https://cdn.adserver.example/redirect/x"));
  assert.ok(!re.test("https://notadserver.example/redirect/x"));
  assert.ok(patternToRegExp("||x.com^").test("https://x.com/"));
  assert.ok(!patternToRegExp("||x.com^").test("https://x.community/"));
});

test("closes ad popups, keeps normal new tabs", () => {
  assert.equal(isAdPopup(data, "https://popads.example/landing", "news.site"), true);
  assert.equal(isAdPopup(data, "https://www.popads.example/x", "news.site"), true);
  assert.equal(isAdPopup(data, "https://clickfarm.example/", "news.site"), true);
  assert.equal(isAdPopup(data, "https://streamsite.example/go/offer?id=1", "streamsite.example"), true);
  assert.equal(isAdPopup(data, "https://other.example/go/offer?id=1", "streamsite.example"), true, "any destination, from that site");
  assert.equal(isAdPopup(data, "https://other.example/go/offer?id=1", "elsewhere.example"), false, "rule is limited to streamsite");
  assert.equal(isAdPopup(data, "https://adserver.example/redirect/legit", "news.site"), false, "exception");
  assert.equal(isAdPopup(data, "https://wikipedia.org/wiki/X", "news.site"), false);
  assert.equal(isAdPopup(data, "chrome://newtab/", "news.site"), false);
});

test("same-site ad bridges are closed when a site.* rule says so (hianime /continue)", () => {
  const { data: d } = compilePopups(["/continue?$popup,domain=hianime.*\n/continue|$popup,domain=hianime.*"]);
  assert.equal(isAdPopup(d, "https://hianime.ms/continue?i=3&t=1712", "hianime.ms"), true);
  assert.equal(isAdPopup(d, "https://hianime.to/continue", "hianime.to"), true);
  assert.equal(isAdPopup(d, "https://hianime.ms/watch-one-piece-episode-1181", "hianime.ms"), false, "normal links still open");
  assert.equal(isAdPopup(d, "https://hianime.ms/continue-watching", "hianime.ms"), false);
  assert.equal(isAdPopup(d, "https://other.example/continue?x", "other.example"), false, "other sites unaffected");
});
