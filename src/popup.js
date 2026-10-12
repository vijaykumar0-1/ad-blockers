// LocalBlock popup: shows status for the current tab and toggles pausing.

const $ = (id) => document.getElementById(id);

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error || "No response from LocalBlock.");
  return res.result;
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

function render({ host, pausedEverywhere, sitePaused }) {
  const blockingHere = Boolean(host) && !pausedEverywhere && !sitePaused;
  $("host").textContent = host || "No site on this tab";
  $("global-toggle").checked = !pausedEverywhere;
  $("site-toggle").checked = !sitePaused;
  $("site-toggle").disabled = !host || pausedEverywhere;
  const pill = $("status-pill");
  pill.textContent = blockingHere ? "Blocking" : "Paused";
  pill.className = "pill " + (blockingHere ? "on" : "off");
}

async function blockedCount(tabId) {
  // Chrome keeps this count itself; reading it needs activeTab, which the popup click grants.
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
    return rulesMatchedInfo.filter((m) => m.rule.rulesetId !== "_dynamic").length;
  } catch {
    const text = await chrome.action.getBadgeText({ tabId }).catch(() => "");
    return Number.parseInt(text, 10) || 0;
  }
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    const url = new URL(tab?.url || "");
    if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
  } catch { /* chrome://, file:// etc. have no site */ }

  render(await send("getStatus", { host }));
  if (tab?.id !== undefined) $("blocked").textContent = String(await blockedCount(tab.id));

  const changed = async (fn) => {
    showError("");
    try {
      render(await fn());
      $("hint").hidden = false;
    } catch (err) {
      showError(err.message);
    }
  };

  $("site-toggle").addEventListener("change", (e) =>
    changed(() => send("setSitePaused", { host, paused: !e.target.checked }))
  );
  $("global-toggle").addEventListener("change", (e) =>
    changed(() => send("setPausedEverywhere", { host, paused: !e.target.checked }))
  );
}

main().catch((err) => showError(err.message));
