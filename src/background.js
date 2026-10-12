// LocalBlock service worker.
// Handles pausing (per site and everywhere) and the blocked-count badge.
// This file makes no network requests of its own.

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
}

async function listPausedSites() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules
    .filter((r) => r.action.type === "allowAllRequests")
    .flatMap((r) => r.condition.requestDomains || []);
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
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// ---- messages from the popup --------------------------------------------

const handlers = {
  async getStatus({ host }) {
    host = normalizeHost(host);
    const { pausedEverywhere } = await getState();
    const sitePaused = host ? Boolean(await findSiteRule(host)) : false;
    return { host, pausedEverywhere, sitePaused };
  },
  async setSitePaused({ host, paused }) {
    await setSitePaused(host, paused);
    return handlers.getStatus({ host });
  },
  async setPausedEverywhere({ paused, host }) {
    await applyGlobalPause(paused);
    return handlers.getStatus({ host });
  },
  async listPausedSites() {
    return { sites: await listPausedSites() };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from this extension's own pages.
  if (sender.id !== chrome.runtime.id || !handlers[msg?.type]) return false;
  handlers[msg.type](msg)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the channel open for the async response
});
