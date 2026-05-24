const apiKeyInput    = document.getElementById("apiKeyInput");
const toggleVisBtn   = document.getElementById("toggleVisibility");
const saveBtn        = document.getElementById("saveBtn");
const removeKeyBtn   = document.getElementById("removeKeyBtn");
const keyStatus      = document.getElementById("keyStatus");
const clearCacheBtn  = document.getElementById("clearCacheBtn");
const cacheStatus    = document.getElementById("cacheStatus");

// ── Load existing key ────────────────────────────────────────────────────────

chrome.storage.local.get("claudeApiKey", (data) => {
  if (data.claudeApiKey) {
    apiKeyInput.value = data.claudeApiKey;
  }
});

// ── Toggle visibility ────────────────────────────────────────────────────────

toggleVisBtn.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleVisBtn.textContent = isPassword ? "🙈" : "👁";
});

// ── Save key ─────────────────────────────────────────────────────────────────

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

// ── Remove key ───────────────────────────────────────────────────────────────

removeKeyBtn.addEventListener("click", () => {
  apiKeyInput.value = "";
  chrome.storage.local.remove("claudeApiKey", () => {
    flashStatus(keyStatus, "API key removed.", "success");
  });
});

// ── Clear cache ───────────────────────────────────────────────────────────────

clearCacheBtn.addEventListener("click", () => {
  chrome.storage.local.get(null, (allData) => {
    const toRemove = Object.keys(allData).filter(k =>
      k.startsWith("analysis_") || k.startsWith("status_") || k.startsWith("links_")
    );
    if (toRemove.length === 0) {
      flashStatus(cacheStatus, "No cached analyses to clear.", "success");
      return;
    }
    chrome.storage.local.remove(toRemove, () => {
      flashStatus(cacheStatus, `Cleared analyses for ${toRemove.filter(k => k.startsWith("analysis_")).length} domain(s).`, "success");
    });
  });
});

// ── Helper ───────────────────────────────────────────────────────────────────

function flashStatus(el, msg, type) {
  el.textContent = msg;
  el.className = `status ${type}`;
  setTimeout(() => { el.className = "status"; }, 4000);
}