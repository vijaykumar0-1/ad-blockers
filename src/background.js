// LocalBlock service worker.
// Handles pausing (per site and everywhere), the blocked-count badge and cosmetic filtering.
// It makes no network requests; rules/cosmetic.json is read from inside the extension.

import { hostCandidates, pagePlan, selectorsForTokens, toCss } from "./cosmetic-lookup.js";

// Every static ruleset declared in manifest.json (base, easylist, easyprivacy, ...).
const RULESETS = chrome.runtime
  .getManifest()
  .declarative_net_request.rule_resources.map((r) => r.id);
const ALLOW_PRIORITY = 100; // must beat every list rule (priorities 1-3)

// ---- state helpers -------------------------------------------------------

async function getState() {
  const { pausedEverywhere = false } = await chrome.storage.local.get("pausedEverywhere");
  return { pausedEverywhere };
}

async function applyGlobalPause(paused) {
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    paused
      ? { disableRulesetIds: RULESETS }
      : { enableRulesetIds: RULESETS }
  );
  await chrome.storage.local.set({ pausedEverywhere: paused });
}

// Per-site pauses are dynamic "allowAllRequests" rules: every request made
// by a page on that site is allowed, whichever rules would otherwise block it.

function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/^www\./, "");
}

async function findSiteRule(host) {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.find(
    (r) =>
      r.action.type === "allowAllRequests" &&
      r.condition.requestDomains?.length === 1 &&
      r.condition.requestDomains[0] === host
  );
}

async function setSitePaused(host, paused) {
  host = normalizeHost(host);
  if (!host) throw new Error("This page has no site to pause.");
  const existing = await findSiteRule(host);
  if (paused && !existing) {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const nextId = rules.reduce((max, r) => Math.max(max, r.id), 0) + 1;
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [
        {
          id: nextId,
          priority: ALLOW_PRIORITY,
          action: { type: "allowAllRequests" },
          condition: {
            requestDomains: [host],
            resourceTypes: ["main_frame", "sub_frame"],
          },
        },
      ],
    });
  } else if (!paused && existing) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [existing.id],
    });
  }
  pauseCache = null;
}

// Paused state is needed on every page load, so keep it in memory.
let pauseCache = null;
async function pauseState() {
  if (!pauseCache) {
    pauseCache = (async () => ({
      everywhere: (await getState()).pausedEverywhere,
      sites: new Set(await listPausedSites()),
    }))();
  }
  return pauseCache;
}
chrome.storage.onChanged.addListener(() => (pauseCache = null));

async function listPausedSites() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules
    .filter((r) => r.action.type === "allowAllRequests")
    .flatMap((r) => r.condition.requestDomains || []);
}

// ---- cosmetic filtering ------------------------------------------------

let cosmeticData = null;
function loadCosmetic() {
  cosmeticData ||= fetch(chrome.runtime.getURL("rules/cosmetic.json")).then((r) => r.json());
  return cosmeticData;
}

// Plans per document, so each frame's selectors are computed once.
const plans = new Map();
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of plans.keys()) if (key.startsWith(tabId + ":")) plans.delete(key);
});

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : "";
  } catch {
    return "";
  }
}

async function planFor(sender) {
  const key = `${sender.tab.id}:${sender.documentId || sender.frameId}`;
  if (plans.has(key)) return plans.get(key);
  const plan = (async () => {
    // about:blank and srcdoc frames inherit their parent's origin.
    const host = hostOf(sender.origin) || hostOf(sender.url);
    const topHost = hostOf(sender.tab.url) || host;
    if (!host) return null;
    const pause = await pauseState();
    if (pause.everywhere || hostCandidates(topHost).some((h) => pause.sites.has(normalizeHost(h)))) {
      return null;
    }
    return pagePlan(await loadCosmetic(), host);
  })();
  plans.set(key, plan);
  if (plans.size > 500) plans.delete(plans.keys().next().value);
  return plan;
}

async function injectCss(sender, selectors) {
  if (!selectors.length) return;
  const target = sender.documentId
    ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
    : { tabId: sender.tab.id, frameIds: [sender.frameId] };
  // USER-origin CSS outranks the page's own !important styles and is invisible to the page.
  await chrome.scripting
    .insertCSS({ target, css: toCss(selectors), origin: "USER" })
    .catch(() => undefined); // the frame may already be gone
}

// ---- scriptlets ------------------------------------------------------------
// Each file in rules/scriptlets/ is registered to run inside pages (MAIN world, before the
// page's own scripts) on the sites that have filters for it, minus paused sites.

const SCRIPTLET_PREFIX = "scriptlet-";

function sitePatterns(host) {
  return [`*://${host}/*`, `*://*.${host}/*`];
}

let syncing = Promise.resolve();
function syncScriptlets() {
  syncing = syncing.then(doSyncScriptlets).catch((err) => console.warn("LocalBlock scriptlets:", err));
  return syncing;
}

async function doSyncScriptlets() {
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const ours = registered.filter((s) => s.id.startsWith(SCRIPTLET_PREFIX)).map((s) => s.id);
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });

  const pause = await pauseState();
  if (pause.everywhere) return;
  const index = await fetch(chrome.runtime.getURL("rules/scriptlets/index.json")).then((r) => r.json());
  const excludeMatches = [...pause.sites].flatMap(sitePatterns);
  for (const { id, file, hosts } of index) {
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: SCRIPTLET_PREFIX + id,
          js: [file],
          matches: hosts.flatMap(sitePatterns),
          ...(excludeMatches.length ? { excludeMatches } : {}),
          runAt: "document_start",
          world: "MAIN",
          allFrames: true,
          persistAcrossSessions: true,
        },
      ]);
    } catch (err) {
      console.warn(`LocalBlock: could not register ${file}:`, err);
    }
  }
}

// ---- lifecycle -----------------------------------------------------------

async function init() {
  // Show how many requests were blocked on each tab, counted by Chrome itself.
  await chrome.declarativeNetRequest.setExtensionActionOptions({
    displayActionCountAsBadgeText: true,
  });
  await chrome.action.setBadgeBackgroundColor({ color: "#3a3a3a" });
  // Enabled rulesets reset when the extension updates, so re-apply the saved state.
  const { pausedEverywhere } = await getState();
  await applyGlobalPause(pausedEverywhere);
  await syncScriptlets();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// ---- messages -------------------------------------------------------------

// From the popup (an extension page, so no sender.tab).
const handlers = {
  async getStatus({ host }) {
    host = normalizeHost(host);
    const { pausedEverywhere } = await getState();
    const sitePaused = host ? Boolean(await findSiteRule(host)) : false;
    return { host, pausedEverywhere, sitePaused };
  },
  async setSitePaused({ host, paused }) {
    await setSitePaused(host, paused);
    await syncScriptlets();
    return handlers.getStatus({ host });
  },
  async setPausedEverywhere({ paused, host }) {
    await applyGlobalPause(paused);
    pauseCache = null;
    await syncScriptlets();
    return handlers.getStatus({ host });
  },
  async listPausedSites() {
    return { sites: await listPausedSites() };
  },
};

// From LocalBlock's content script running in web pages.
const contentHandlers = {
  async "cosmetic:page"(msg, sender) {
    const plan = await planFor(sender);
    if (!plan) return { active: false };
    await injectCss(sender, plan.selectors);
    return { active: plan.generic };
  },
  async "cosmetic:tokens"(msg, sender) {
    const plan = await planFor(sender);
    if (!plan || !Array.isArray(msg.tokens)) return {};
    const tokens = msg.tokens.filter((t) => typeof t === "string").slice(0, 5000);
    await injectCss(sender, selectorsForTokens(await loadCosmetic(), tokens, plan));
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  // Pages can only reach the content-script handlers; only the popup can change settings.
  const handler = sender.tab ? contentHandlers[msg?.type] : handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the channel open for the async response
});
