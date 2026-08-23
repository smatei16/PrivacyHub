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

/**
 * Renders `items` into `container` as chips, capped at `cap` visible items.
 * Any remainder is hidden behind a clickable/keyboard-activatable "+N more"
 * chip that, on activation, removes itself and reveals the rest in place -
 * so long lists (e.g. collectedData) don't overwhelm the popup by default
 * but everything stays reachable.
 * @param {HTMLElement} container - <ul>/<ol> to fill.
 * @param {string[]} items - Chip label strings, in display order.
 * @param {number} cap - Max chips to show before collapsing the rest.
 * @param {string} [chipClass="chip"] - CSS class for each visible-item chip.
 */
function renderExpandableChips(container, items, cap, chipClass = "chip") {
  container.innerHTML = "";

  const appendChip = (text) => {
    const li = document.createElement("li");
    li.className = chipClass;
    li.textContent = text;
    container.appendChild(li);
  };

  const visible = items.slice(0, cap);
  const hidden  = items.slice(cap);

  visible.forEach(appendChip);

  if (hidden.length > 0) {
    const moreLi = document.createElement("li");
    moreLi.className = "chip chip--more";
    moreLi.textContent = `+${hidden.length} more`;
    moreLi.tabIndex = 0;
    moreLi.setAttribute("role", "button");
    moreLi.setAttribute("aria-label", `Show ${hidden.length} more`);

    const expand = () => {
      moreLi.remove();
      hidden.forEach(appendChip);
    };
    moreLi.addEventListener("click", expand);
    moreLi.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        expand();
      }
    });

    container.appendChild(moreLi);
  }
}

/**
 * Normalizes one "collectedData" entry into `{ type, conditional, context }`.
 * background.js already normalizes fresh analyses into this shape before
 * caching, but a result can also come straight from `analysis_<domain>`
 * storage written by an older version of the extension, where each entry
 * was a plain string with no conditional/context concept at all - that case
 * is treated as unconditional data, matching the old behavior.
 * @param {string|object} item - Raw entry from `result.collectedData`.
 * @returns {{type: string, conditional: boolean, context: string}}
 */
function normalizeDataItem(item) {
  if (typeof item === "string") {
    return { type: item, conditional: false, context: "" };
  }
  return {
    type: item?.type || "",
    conditional: item?.conditional === true,
    context: typeof item?.context === "string" ? item.context : ""
  };
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
  // Capped client-side at 4, mirroring the prompt instruction in
  // background.js - kept here too as a fallback so a verbose response never
  // defeats the point of showing concerns as short, skimmable chips. Any
  // extra concerns are still reachable via the expandable "+N more" chip.
  const concernsList = document.getElementById("concernsList");
  const allConcerns = result.concerns || [];
  if (allConcerns.length === 0) {
    document.getElementById("concernsCard").classList.add("hidden");
  } else {
    document.getElementById("concernsCard").classList.remove("hidden");
    renderExpandableChips(concernsList, allConcerns, 4, "chip chip--warn");
  }

  // Data collected
  // Split into data collected from every visitor ("unconditional") vs. data
  // the policy only mentions for a specific optional action - job
  // applications, account signup, etc. ("conditional", see background.js's
  // prompt rules). Showing both in one flat list overstates what a plain
  // visitor is actually exposed to, so conditional items are collapsed
  // behind a toggle instead, with the triggering action available on hover.
  const dataList = document.getElementById("dataList");
  const conditionalToggle = document.getElementById("conditionalDataToggle");
  const conditionalList = document.getElementById("conditionalDataList");
  const allItems = (result.collectedData || []).map(normalizeDataItem).filter(i => i.type);
  const unconditional = allItems.filter(i => !i.conditional);
  const conditional = allItems.filter(i => i.conditional);

  if (unconditional.length === 0) {
    dataList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "chip";
    li.textContent = "None detected";
    dataList.appendChild(li);
  } else {
    renderExpandableChips(dataList, unconditional.map(i => i.type), 10, "chip");
  }

  conditionalList.innerHTML = "";
  if (conditional.length === 0) {
    conditionalToggle.classList.add("hidden");
    conditionalList.classList.add("hidden");
  } else {
    conditionalToggle.classList.remove("hidden");
    conditionalList.classList.add("hidden");
    conditionalToggle.textContent =
      `▸ Show ${conditional.length} more (only if you use certain features)`;

    const revealConditional = () => {
      conditional.forEach(item => {
        const li = document.createElement("li");
        li.className = "chip chip--conditional";
        li.textContent = item.type;
        if (item.context) li.title = `Only if you ${item.context}`;
        conditionalList.appendChild(li);
      });
      conditionalList.classList.remove("hidden");
      conditionalToggle.classList.add("hidden");
    };
    // Assigned (not addEventListener) so a later renderResults() call - e.g.
    // after re-analyzing - replaces the previous handler instead of
    // stacking a second one on this persistent DOM element.
    conditionalToggle.onclick = revealConditional;
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

  // Delete your data
  // "contact" (if present) is only ever a literal email or URL Claude found
  // in the policy text itself (see the prompt rules) - never fabricated -
  // so it's safe to turn straight into a mailto:/link without further checks
  // beyond telling the two apart for the link's own href/label.
  const deletion = result.dataDeletion || {
    method: "not_specified",
    instructions: "Not addressed in this policy - check account settings or contact support.",
    contact: ""
  };
  document.getElementById("deletionInstructions").textContent = deletion.instructions;

  const deletionLink = document.getElementById("deletionContactLink");
  const contact = deletion.contact || "";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    deletionLink.href = `mailto:${contact}`;
    deletionLink.textContent = contact;
    deletionLink.classList.remove("hidden");
  } else if (/^https?:\/\//i.test(contact)) {
    deletionLink.href = contact;
    deletionLink.textContent = "Open deletion request page";
    deletionLink.classList.remove("hidden");
  } else {
    deletionLink.classList.add("hidden");
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

// ── HIBP Breach Check ────────────────────────────────────────────────────────

const HIBP_STATES = ["hibpLoading", "hibpNoKey", "hibpError", "hibpSafe", "hibpBreaches"];

function showHibpState(id) {
  HIBP_STATES.forEach(sid =>
    document.getElementById(sid).classList.toggle("hidden", sid !== id)
  );
}

const HIGH_SEVERITY_DATA = new Set([
  "Passwords", "Credit cards", "Credit card CVV", "Credit card numbers",
  "Financial data", "Bank account numbers", "Social security numbers",
  "Health insurance information", "Medical records", "Private messages",
  "Auth tokens", "Government issued IDs", "Partial credit card data",
  "Security questions and answers"
]);

const MEDIUM_SEVERITY_DATA = new Set([
  "Email addresses", "Phone numbers", "Physical addresses",
  "Dates of birth", "IP addresses", "Usernames", "Geographic locations"
]);

function dataChipClass(dataClass) {
  if (HIGH_SEVERITY_DATA.has(dataClass)) return "chip chip--danger";
  if (MEDIUM_SEVERITY_DATA.has(dataClass)) return "chip chip--warn";
  return "chip";
}

function breachSeverity(breaches) {
  const mostRecent = breaches.reduce((a, b) =>
    new Date(a.BreachDate) > new Date(b.BreachDate) ? a : b
  );
  const ageYears = (Date.now() - new Date(mostRecent.BreachDate)) / (365.25 * 24 * 60 * 60 * 1000);
  if (ageYears < 2) return "critical";
  if (ageYears < 5) return "warning";
  return "old";
}

function cardSeverity(breachDate) {
  const ageYears = (Date.now() - new Date(breachDate)) / (365.25 * 24 * 60 * 60 * 1000);
  if (ageYears < 2) return "critical";
  if (ageYears < 5) return "warning";
  return "old";
}

function formatBreachDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}K`;
  return n.toString();
}

function renderHIBP(breaches) {
  if (!breaches.length) {
    showHibpState("hibpSafe");
    return;
  }

  const sev = breachSeverity(breaches);
  const mostRecent = breaches.reduce((a, b) =>
    new Date(a.BreachDate) > new Date(b.BreachDate) ? a : b
  );
  const lastDate = formatBreachDate(mostRecent.BreachDate);
  const count    = breaches.length;
  const plural   = count > 1 ? "es" : "";

  document.getElementById("hibpAlert").className = `hibp-alert hibp-alert--${sev}`;

  const titles = {
    critical: `${count} breach${plural} found - recent`,
    warning:  `${count} breach${plural} found`,
    old:      `${count} old breach${plural} found`
  };
  const subs = {
    critical: `Last breach: ${lastDate}. If you have an account here, change your password now.`,
    warning:  `Last breach: ${lastDate}. Consider updating your password on this site.`,
    old:      `Last breach: ${lastDate}. Credentials from this site may be outdated.`
  };

  document.getElementById("hibpAlertTitle").textContent = titles[sev];
  document.getElementById("hibpAlertSub").textContent   = subs[sev];

  // Sort by most recent first
  const sorted = [...breaches].sort((a, b) => new Date(b.BreachDate) - new Date(a.BreachDate));

  const listEl  = document.getElementById("hibpBreachList");
  listEl.innerHTML = "";

  const MAX_VISIBLE = 3;

  sorted.forEach((breach, i) => {
    const csev  = cardSeverity(breach.BreachDate);
    const card  = document.createElement("div");
    card.className = `hibp-breach-card hibp-breach-card--${csev}${i >= MAX_VISIBLE ? " hidden hibp-extra" : ""}`;

    const badges = [];
    if (breach.IsSensitive)           badges.push(`<span class="hibp-badge hibp-badge--sensitive">Sensitive</span>`);
    if (breach.IsVerified === false)   badges.push(`<span class="hibp-badge hibp-badge--unverified">Unverified</span>`);

    const chipsHtml = (breach.DataClasses || [])
      .map(dc => `<span class="${esc(dataChipClass(dc))}">${esc(dc)}</span>`)
      .join("");

    card.innerHTML = `
      <div class="hibp-breach-header">
        <span class="hibp-breach-name">${esc(breach.Title || breach.Name)}</span>
        <span class="hibp-breach-date">${formatBreachDate(breach.BreachDate)}</span>
      </div>
      <p class="hibp-breach-meta">${formatCount(breach.PwnCount)} accounts affected</p>
      <div class="hibp-breach-chips">${chipsHtml}</div>
      ${badges.length ? `<div class="hibp-breach-badges">${badges.join("")}</div>` : ""}
    `;
    listEl.appendChild(card);
  });

  const showMoreBtn = document.getElementById("hibpShowMore");
  if (sorted.length > MAX_VISIBLE) {
    const remaining = sorted.length - MAX_VISIBLE;
    showMoreBtn.textContent = `Show ${remaining} more breach${remaining > 1 ? "es" : ""}`;
    showMoreBtn.classList.remove("hidden");
  } else {
    showMoreBtn.classList.add("hidden");
  }

  showHibpState("hibpBreaches");
}

function checkHIBP() {
  showHibpState("hibpLoading");
  chrome.runtime.sendMessage({ type: "CHECK_HIBP", domain: currentDomain }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      showHibpState("hibpError");
      document.getElementById("hibpErrorMsg").textContent = "Could not reach extension background.";
      return;
    }
    switch (resp.status) {
      case "no_key":
        showHibpState("hibpNoKey");
        break;
      case "done":
        renderHIBP(resp.breaches);
        break;
      case "error":
        showHibpState("hibpError");
        document.getElementById("hibpErrorMsg").textContent = resp.message || "Could not check breach database.";
        break;
    }
  });
}

// ── Initialization ───────────────────────────────────────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab?.url || /^(chrome|edge|about|data):/.test(tab.url)) {
    document.getElementById("domainText").textContent = "-";
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

  // Show HIBP section and start breach check immediately
  document.getElementById("hibpSection").classList.remove("hidden");
  checkHIBP();

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

document.getElementById("hibpSettingsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("hibpShowMore").addEventListener("click", () => {
  document.querySelectorAll(".hibp-extra").forEach(el => el.classList.remove("hidden"));
  document.getElementById("hibpShowMore").classList.add("hidden");
});