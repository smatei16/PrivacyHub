const POLL_MS = 2000;

let currentDomain = "";
let currentLinks  = [];
let pollTimer     = null;

// ── Utilities ────────────────────────────────────────────────────────────────

const ALL_STATES = ["stateLoading", "stateNoKey", "stateNone", "stateError", "stateReady", "stateResults"];

function showState(id) {
  ALL_STATES.forEach(sid => {
    document.getElementById(sid).classList.toggle("hidden", sid !== id);
  });
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function scoreColor(score) {
  if (score >= 8) return "#16a34a";
  if (score >= 5) return "#d97706";
  return "#dc2626";
}

function scoreLabel(score) {
  if (score >= 8) return "Excellent";
  if (score >= 5) return "Moderate";
  return "Poor";
}

function scoreDescription(score) {
  if (score >= 8) return "This site has strong privacy practices.";
  if (score >= 5) return "This site has moderate privacy practices.";
  return "This site has weak privacy practices.";
}

// ── Render results ───────────────────────────────────────────────────────────

function renderResults(result) {
  stopPolling();

  const score = result.privacyScore || 1;
  const color = scoreColor(score);
  const pct   = (score / 10) * 100;

  // Score ring (conic-gradient donut)
  document.getElementById("scoreRing").style.background =
    `conic-gradient(${color} ${pct * 3.6}deg, #e2e8f0 0deg)`;

  const scoreNumEl = document.getElementById("scoreNum");
  scoreNumEl.textContent = score;
  scoreNumEl.style.color = color;

  const badge = document.getElementById("scoreBadge");
  badge.textContent = scoreLabel(score);
  badge.style.backgroundColor = color + "22";
  badge.style.color = color;

  const fill = document.getElementById("scoreBarFill");
  fill.style.width = pct + "%";
  fill.style.backgroundColor = color;

  document.getElementById("scoreDesc").textContent = scoreDescription(score);

  // Summary
  document.getElementById("summaryText").textContent = result.summary || "No summary available.";

  // Concerns
  const concernsList = document.getElementById("concernsList");
  concernsList.innerHTML = "";
  const concerns = result.concerns || [];
  if (concerns.length === 0) {
    document.getElementById("concernsCard").classList.add("hidden");
  } else {
    document.getElementById("concernsCard").classList.remove("hidden");
    concerns.forEach(c => {
      const li = document.createElement("li");
      li.className = "chip chip--warn";
      li.textContent = c;
      concernsList.appendChild(li);
    });
  }

  // Data collected
  const dataList = document.getElementById("dataList");
  dataList.innerHTML = "";
  const allData = result.collectedData || [];
  const visibleData = allData.slice(0, 10);
  if (visibleData.length === 0) {
    const li = document.createElement("li");
    li.className = "chip";
    li.textContent = "None detected";
    dataList.appendChild(li);
  } else {
    visibleData.forEach(d => {
      const li = document.createElement("li");
      li.className = "chip";
      li.textContent = d;
      dataList.appendChild(li);
    });
    if (allData.length > 10) {
      const li = document.createElement("li");
      li.className = "chip chip--more";
      li.textContent = `+${allData.length - 10} more`;
      dataList.appendChild(li);
    }
  }

  // Third parties
  const vendorList = document.getElementById("vendorList");
  vendorList.innerHTML = "";
  const vendors = result.thirdParties || [];
  if (vendors.length === 0) {
    document.getElementById("thirdPartiesCard").classList.add("hidden");
  } else {
    document.getElementById("thirdPartiesCard").classList.remove("hidden");
    vendors.forEach(v => {
      const li = document.createElement("li");
      li.className = "vendor-item";
      li.innerHTML = `
        <div class="vendor-name">${esc(v.name || "Unknown")}</div>
        <div class="vendor-purpose">${esc(v.purpose || "")}</div>
      `;
      vendorList.appendChild(li);
    });
  }

  showState("stateResults");
}

// ── Polling ──────────────────────────────────────────────────────────────────

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(checkStatus, POLL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function checkStatus() {
  chrome.runtime.sendMessage({ type: "GET_STATUS", domain: currentDomain }, handleStatus);
}

function handleStatus(response) {
  if (!response) {
    stopPolling();
    showError("Extension error. Try reopening the popup.");
    return;
  }

  switch (response.status) {
    case "done":
      renderResults(response.result);
      break;

    case "analyzing":
      showState("stateLoading");
      startPolling();
      break;

    case "ready":
      stopPolling();
      currentLinks = response.links || [];
      document.getElementById("policyLinksFound").textContent =
        `Found ${currentLinks.length} policy page${currentLinks.length !== 1 ? "s" : ""}.`;
      showState("stateReady");
      break;

    case "no_data":
      stopPolling();
      // Fallback: ask content script directly
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) { showState("stateNone"); return; }
        chrome.tabs.sendMessage(tabs[0].id, { type: "GET_POLICY_LINKS" }, (linksResponse) => {
          if (chrome.runtime.lastError || !linksResponse?.links?.length) {
            showState("stateNone");
            return;
          }
          currentLinks = linksResponse.links;
          chrome.runtime.sendMessage({
            type: "POLICY_LINKS_FOUND",
            domain: currentDomain,
            links: currentLinks
          });
          document.getElementById("policyLinksFound").textContent =
            `Found ${currentLinks.length} policy page${currentLinks.length !== 1 ? "s" : ""}.`;
          showState("stateReady");
        });
      });
      break;

    default:
      if (response.status && response.status.startsWith("error_")) {
        stopPolling();
        showError(response.status.replace("error_", "") || "Analysis failed.");
      }
  }
}

function showError(msg) {
  document.getElementById("errorDetail").textContent = msg;
  showState("stateError");
}

// ── Trigger analysis ─────────────────────────────────────────────────────────

function triggerAnalysis() {
  if (!currentLinks.length) {
    showError("No policy links available. Try refreshing the page.");
    return;
  }
  showState("stateLoading");
  document.getElementById("loadingDetail").textContent = "Fetching policy pages...";
  chrome.runtime.sendMessage(
    { type: "TRIGGER_ANALYSIS", domain: currentDomain, links: currentLinks },
    (response) => {
      if (!response) { showError("Could not reach the extension background."); return; }
      startPolling();
    }
  );
}

// ── Initialization ───────────────────────────────────────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab?.url || /^(chrome|edge|about|data):/.test(tab.url)) {
    document.getElementById("domainText").textContent = "—";
    showState("stateNone");
    return;
  }

  try {
    currentDomain = new URL(tab.url).hostname;
    document.getElementById("domainText").textContent = currentDomain;
  } catch {
    showState("stateNone");
    return;
  }

  // Check API key first
  chrome.storage.local.get("claudeApiKey", (data) => {
    if (!data.claudeApiKey) {
      showState("stateNoKey");
      return;
    }

    showState("stateLoading");
    document.getElementById("loadingDetail").textContent = "Checking analysis cache...";
    checkStatus();
  });
});

// ── Button handlers ──────────────────────────────────────────────────────────

document.getElementById("analyzeBtn").addEventListener("click", triggerAnalysis);

document.getElementById("retryBtn").addEventListener("click", () => {
  if (!currentLinks.length) {
    // Try to recover links from storage
    chrome.storage.local.get(`links_${currentDomain}`, (data) => {
      currentLinks = data[`links_${currentDomain}`] || [];
      triggerAnalysis();
    });
  } else {
    triggerAnalysis();
  }
});

document.getElementById("reanalyzeBtn").addEventListener("click", () => {
  // Load fresh links from storage in case this is a re-open
  chrome.storage.local.get(`links_${currentDomain}`, (data) => {
    if (data[`links_${currentDomain}`]?.length) {
      currentLinks = data[`links_${currentDomain}`];
    }
    chrome.storage.local.remove(
      [`analysis_${currentDomain}`, `status_${currentDomain}`],
      triggerAnalysis
    );
  });
});

document.getElementById("settingsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("goToSettingsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});