const apiKeyInput      = document.getElementById("apiKeyInput");
const toggleVisBtn     = document.getElementById("toggleVisibility");
const saveBtn          = document.getElementById("saveBtn");
const removeKeyBtn     = document.getElementById("removeKeyBtn");
const keyStatus        = document.getElementById("keyStatus");
const hibpKeyInput     = document.getElementById("hibpKeyInput");
const hibpToggleBtn    = document.getElementById("hibpToggleVisibility");
const hibpSaveBtn      = document.getElementById("hibpSaveBtn");
const hibpRemoveBtn    = document.getElementById("hibpRemoveBtn");
const hibpKeyStatus    = document.getElementById("hibpKeyStatus");
const autoRejectToggle = document.getElementById("autoRejectToggle");
const clearCacheBtn    = document.getElementById("clearCacheBtn");
const cacheStatus      = document.getElementById("cacheStatus");

// ── Load existing keys and settings ─────────────────────────────────────────

chrome.storage.local.get(["claudeApiKey", "hibpApiKey", "autoRejectCookies"], (data) => {
  if (data.claudeApiKey)    apiKeyInput.value      = data.claudeApiKey;
  if (data.hibpApiKey)      hibpKeyInput.value     = data.hibpApiKey;
  autoRejectToggle.checked = !!data.autoRejectCookies;
});

// ── Claude key — toggle visibility ──────────────────────────────────────────

toggleVisBtn.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleVisBtn.textContent = isPassword ? "🙈" : "👁";
});

// ── Claude key — save ────────────────────────────────────────────────────────

saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    flashStatus(keyStatus, "Please enter an API key.", "error");
    return;
  }
  if (!key.startsWith("sk-ant-")) {
    flashStatus(keyStatus, "This doesn't look like a valid Anthropic API key (should start with sk-ant-).", "error");
    return;
  }
  chrome.storage.local.set({ claudeApiKey: key }, () => {
    flashStatus(keyStatus, "API key saved.", "success");
  });
});

// ── Claude key — remove ──────────────────────────────────────────────────────

removeKeyBtn.addEventListener("click", () => {
  apiKeyInput.value = "";
  chrome.storage.local.remove("claudeApiKey", () => {
    flashStatus(keyStatus, "API key removed.", "success");
  });
});

// ── HIBP key — toggle visibility ─────────────────────────────────────────────

hibpToggleBtn.addEventListener("click", () => {
  const isPassword = hibpKeyInput.type === "password";
  hibpKeyInput.type = isPassword ? "text" : "password";
  hibpToggleBtn.textContent = isPassword ? "🙈" : "👁";
});

// ── HIBP key — save ──────────────────────────────────────────────────────────

hibpSaveBtn.addEventListener("click", () => {
  const key = hibpKeyInput.value.trim();
  if (!key) {
    flashStatus(hibpKeyStatus, "Please enter an API key.", "error");
    return;
  }
  // HIBP keys are UUID-format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(key)) {
    flashStatus(hibpKeyStatus, "Key doesn't match the expected UUID format — double-check it and save anyway?", "error");
    // Still allow saving in case the format changes; just warn.
  }
  chrome.storage.local.set({ hibpApiKey: key }, () => {
    flashStatus(hibpKeyStatus, "HIBP API key saved.", "success");
  });
});

// ── HIBP key — remove ────────────────────────────────────────────────────────

hibpRemoveBtn.addEventListener("click", () => {
  hibpKeyInput.value = "";
  chrome.storage.local.remove("hibpApiKey", () => {
    flashStatus(hibpKeyStatus, "HIBP API key removed.", "success");
  });
});

// ── Auto-reject toggle ────────────────────────────────────────────────────────

autoRejectToggle.addEventListener("change", () => {
  chrome.storage.local.set({ autoRejectCookies: autoRejectToggle.checked });
});

// ── Clear cache ───────────────────────────────────────────────────────────────

clearCacheBtn.addEventListener("click", () => {
  chrome.storage.local.get(null, (allData) => {
    const toRemove = Object.keys(allData).filter(k =>
      k.startsWith("analysis_") || k.startsWith("status_") ||
      k.startsWith("links_")    || k.startsWith("hibp_")
    );
    // Also reset remembered cookie-banner choices. A past false-positive match
    // (e.g. a "Settings" button unrelated to any cookie banner) could have
    // gotten saved as a domain's "choice", which silently disables auto-reject
    // for that domain forever with no other way to undo it.
    const cookieDomainCount = allData.cookie_choices ? Object.keys(allData.cookie_choices).length : 0;
    if (cookieDomainCount > 0) toRemove.push("cookie_choices");

    if (toRemove.length === 0) {
      flashStatus(cacheStatus, "No cached data to clear.", "success");
      return;
    }
    chrome.storage.local.remove(toRemove, () => {
      const analyses = toRemove.filter(k => k.startsWith("analysis_")).length;
      const breaches = toRemove.filter(k => k.startsWith("hibp_")).length;
      const parts = [];
      if (analyses) parts.push(`${analyses} privacy analysis${analyses > 1 ? "es" : ""}`);
      if (breaches) parts.push(`${breaches} breach cache${breaches > 1 ? "s" : ""}`);
      if (cookieDomainCount) parts.push(`${cookieDomainCount} remembered cookie choice${cookieDomainCount > 1 ? "s" : ""}`);
      flashStatus(cacheStatus, `Cleared: ${parts.join(" and ")}.`, "success");
    });
  });
});

// ── Helper ───────────────────────────────────────────────────────────────────

function flashStatus(el, msg, type) {
  el.textContent = msg;
  el.className = `status ${type}`;
  setTimeout(() => { el.className = "status"; }, 4000);
}