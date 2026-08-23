// In-memory set to track active analyses (survives only for SW lifetime)
const pendingAnalyses = new Set();

// Cookie-choice messages can now arrive from any frame on the page (content.js
// runs with all_frames: true so it can reach cookie banners rendered inside
// cross-origin CMP iframes). message.url is that frame's own URL - inside an
// iframe that's the CMP vendor's domain, not the site the user is on. Prefer
// sender.tab.url (the tab's actual address-bar URL) so choices are always
// filed under the site itself, regardless of which frame handled the banner.
function pageDomainFor(message, sender) {
  const pageUrl = sender.tab?.url || message.url;
  return new URL(pageUrl).hostname;
}

/**
 * Kicks off analysis for `domain` and writes the outcome to storage, same as
 * before this was pulled out of the TRIGGER_ANALYSIS handler - now also
 * called from POLICY_LINKS_FOUND when auto-analyze is on, so both the manual
 * "Analyze Privacy Policy" button and the automatic path share one code
 * path instead of duplicating the pendingAnalyses/status bookkeeping.
 * No-ops if `domain` is already being analyzed (checked via pendingAnalyses,
 * so a manual click can't double-fire alongside an auto-triggered run, or
 * vice versa).
 * @param {string} domain
 * @param {string[]} links
 */
function startAnalysis(domain, links) {
  if (pendingAnalyses.has(domain)) return;

  pendingAnalyses.add(domain);
  chrome.storage.local.set({ [`status_${domain}`]: "analyzing" });

  analyzePolicy(links, domain)
    .then(result => {
      chrome.storage.local.set({
        [`analysis_${domain}`]: result,
        [`status_${domain}`]: "done"
      });
      pendingAnalyses.delete(domain);
    })
    .catch(err => {
      console.error("[PrivacyHub] Analysis failed:", err);
      chrome.storage.local.set({
        [`status_${domain}`]: `error_${err.message}`
      });
      pendingAnalyses.delete(domain);
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Policy link storage ──────────────────────────────────────────────────
  if (message.type === "POLICY_LINKS_FOUND") {
    const domain = message.domain;
    const keys = [`links_${domain}`, `analysis_${domain}`, `status_${domain}`, "autoAnalyzeEnabled", "claudeApiKey"];

    chrome.storage.local.get(keys, (data) => {
      if (!data[`links_${domain}`] || data[`links_${domain}`].length === 0) {
        chrome.storage.local.set({ [`links_${domain}`]: message.links });
      }

      // Auto-analyze: only for a domain with no analysis AND no status at
      // all - not even a past error - so a site that previously failed
      // (e.g. blocks scraping) isn't silently retried on every revisit.
      // A manual retry from the popup is still always available for that.
      const neverTouched = !data[`analysis_${domain}`] && !data[`status_${domain}`];
      if (data.autoAnalyzeEnabled && data.claudeApiKey && neverTouched) {
        startAnalysis(domain, message.links);
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  // ── Status query from popup ──────────────────────────────────────────────
  if (message.type === "GET_STATUS") {
    const domain = message.domain;
    const keys = [`analysis_${domain}`, `status_${domain}`, `links_${domain}`];
    chrome.storage.local.get(keys, (data) => {
      const analysis = data[`analysis_${domain}`];
      const status   = data[`status_${domain}`];
      const links    = data[`links_${domain}`] || [];

      if (analysis) {
        sendResponse({ status: "done", result: analysis });
      } else if (status === "analyzing" && pendingAnalyses.has(domain)) {
        sendResponse({ status: "analyzing" });
      } else if (status && status.startsWith("error_")) {
        sendResponse({ status, links });
      } else if (links.length > 0) {
        // "analyzing" in storage but SW restarted → treat as ready
        sendResponse({ status: "ready", links });
      } else {
        sendResponse({ status: "no_data" });
      }
    });
    return true;
  }

  // ── Trigger analysis ─────────────────────────────────────────────────────
  if (message.type === "TRIGGER_ANALYSIS") {
    startAnalysis(message.domain, message.links);
    sendResponse({ ok: true });
    return true;
  }

  // ── Cookie banner detection (preserved from v1) ──────────────────────────
  if (message.type === "COOKIE_BANNER_DETECTED") {
    const domain = pageDomainFor(message, sender);
    chrome.storage.local.get(["cookie_choices"], (data) => {
      const choices = data.cookie_choices || {};
      if (!choices[domain]) {
        choices[domain] = { detectedButtons: message.buttons };
        chrome.storage.local.set({ cookie_choices: choices }, () => sendResponse());
      } else {
        sendResponse();
      }
    });
    return true;
  }

  if (message.type === "GET_COOKIE_CHOICE") {
    const domain = pageDomainFor(message, sender);
    chrome.storage.local.get(["cookie_choices"], (data) => {
      const choice = data.cookie_choices?.[domain]?.selected || null;
      sendResponse({ choice });
    });
    return true;
  }

  if (message.type === "SAVE_COOKIE_CHOICE") {
    const domain = pageDomainFor(message, sender);
    chrome.storage.local.get(["cookie_choices"], (data) => {
      const choices = data.cookie_choices || {};
      if (!choices[domain]) choices[domain] = {};
      choices[domain].selected = { selector: message.selector, label: message.label, mode: message.mode || "reject" };
      chrome.storage.local.set({ cookie_choices: choices }, () => sendResponse());
    });
    return true;
  }

  // ── HIBP data breach check ───────────────────────────────────────────────────
  if (message.type === "CHECK_HIBP") {
    getHibpBreaches(message.domain).then(sendResponse);
    return true;
  }

  return true;
});

// ── HIBP data breach lookups ─────────────────────────────────────────────────

const HIBP_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days - how long a domain's breach data is trusted before re-fetching.

/**
 * HIBP's Core API tier rate-limits requests (roughly one every 1.5s).
 * getHibpBreaches() is cache-first, so this only matters for cache misses -
 * but both the popup (CHECK_HIBP) and the passive post-navigation check
 * (maybeNotifyBreach) can trigger those, and a burst of newly-visited
 * domains could otherwise fire several requests back to back. Chaining every
 * real outbound request through this single queue, with a fixed gap enforced
 * after each one finishes, keeps that from ever bursting past the limit.
 */
let hibpFetchChain = Promise.resolve();
const HIBP_MIN_GAP_MS = 1600;

function throttledHibpFetch(url, options) {
  const scheduled = hibpFetchChain.then(() => fetch(url, options));
  hibpFetchChain = scheduled
    .catch(() => {}) // one failed request shouldn't jam the queue for the next
    .then(() => new Promise(r => setTimeout(r, HIBP_MIN_GAP_MS)));
  return scheduled;
}

/**
 * Fetches HIBP breach data for `domain`, cache-first (see HIBP_TTL). Shared
 * by the on-demand CHECK_HIBP message handler (popup) and the passive
 * per-navigation check (maybeNotifyBreach) so both paths share one cache and
 * one throttled request queue instead of racing each other.
 * @param {string} domain
 * @returns {Promise<{status: "no_key"|"done"|"error", breaches?: object[], message?: string}>}
 */
async function getHibpBreaches(domain) {
  try {
    const cacheKey = `hibp_${domain}`;
    const stored   = await new Promise(r => chrome.storage.local.get([cacheKey, "hibpApiKey"], r));
    const apiKey   = stored.hibpApiKey;

    if (!apiKey) return { status: "no_key" };

    const cached = stored[cacheKey];
    if (cached && (Date.now() - cached.fetchedAt) < HIBP_TTL) {
      return { status: "done", breaches: cached.breaches };
    }

    const rootDomain = getRootDomain(domain);
    const res = await throttledHibpFetch(
      `https://haveibeenpwned.com/api/v3/breaches?domain=${encodeURIComponent(rootDomain)}`,
      { headers: { "hibp-api-key": apiKey, "user-agent": "PrivacyHub/2.0" } }
    );

    if (res.status === 401) return { status: "error", message: "Invalid HIBP API key." };
    if (!res.ok && res.status !== 404) return { status: "error", message: `HIBP API returned ${res.status}.` };

    const breaches = res.ok ? await res.json() : [];
    chrome.storage.local.set({ [cacheKey]: { breaches, fetchedAt: Date.now() } });
    return { status: "done", breaches };
  } catch (err) {
    return { status: "error", message: err.message };
  }
}

// ── Passive breach notifications ─────────────────────────────────────────────
// Everything above only runs when the popup asks for it. The whole point of
// this section is that most users never open the popup on every site they
// visit, so without it a real breach would go unnoticed. This listens for
// completed page loads and, if the user has opted in, runs the same
// cache-first check silently and raises an OS notification when it finds
// something - throttled per-domain so revisits don't spam the same alert.

/** Maps a live notification id -> the tabId that triggered it (best-effort, in-memory only; lost on service-worker restart, which just means a click falls back to opening the popup on whatever tab is currently active). */
const notificationTabs = new Map();

/**
 * Per-cooldown-setting minimum gap, in ms, before re-notifying about the
 * same domain. "always" means no cooldown at all; "never" (Infinity) means
 * a domain gets exactly one notification ever, then no repeats - handled
 * as a special case in maybeNotifyBreach since a naive comparison against
 * Infinity would also swallow that first notification.
 */
const COOLDOWN_MS = {
  always: 0,
  "1d": 1 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  never: Infinity
};

/**
 * HIBP's /breaches?domain= endpoint returns every breach it has on record
 * for a domain, no matter how old - a domain whose only breach was a decade
 * ago looks identical to one breached last week. Without filtering, that
 * makes "Data breach detected" misleading for old, already-public breaches.
 * This maps the user's "only notify for recent breaches" setting to a max
 * age in ms; "any" (null) means no filtering, matching the pre-filter
 * behavior for anyone who hasn't touched the new setting.
 */
const RECENCY_MS = {
  any: null,
  "2y": 2 * 365.25 * 24 * 60 * 60 * 1000,
  "5y": 5 * 365.25 * 24 * 60 * 60 * 1000
};

/**
 * Formats a breach's BreachDate for display, e.g. "Mar 2023" - mirrors
 * formatBreachDate() in popup.js so the date reads the same whether the
 * user sees it in a notification or in the popup's breach list.
 * @param {string} dateStr
 * @returns {string}
 */
function formatBreachDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/**
 * Returns the breach with the latest BreachDate, or null for an empty list.
 * @param {object[]} breaches
 * @returns {object|null}
 */
function mostRecentBreach(breaches) {
  return breaches.reduce(
    (latest, b) => (!latest || new Date(b.BreachDate) > new Date(latest.BreachDate)) ? b : latest,
    null
  );
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  let domain;
  try {
    const u = new URL(tab.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return; // skip chrome://, file://, etc.
    domain = u.hostname;
  } catch {
    return;
  }

  maybeNotifyBreach(tabId, domain);
});

/**
 * Runs a silent, cache-first breach check for `domain` and raises an OS
 * notification if it has known breaches and hasn't been notified about
 * within the user's configured cooldown. No-ops immediately (no network
 * request) if the feature is off or no HIBP key is configured, so a user who
 * hasn't opted in never pays the cost of this running on every navigation.
 * @param {number} tabId - The tab that navigated, used so clicking the
 *   notification can jump back to it (see chrome.notifications.onClicked).
 * @param {string} domain
 */
async function maybeNotifyBreach(tabId, domain) {
  const settings = await new Promise(r => chrome.storage.local.get(
    ["breachNotificationsEnabled", "breachNotifyCooldown", "breachNotifyRecency", "hibpApiKey"], r
  ));
  if (!settings.breachNotificationsEnabled || !settings.hibpApiKey) return;

  const result = await getHibpBreaches(domain);
  if (result.status !== "done" || !result.breaches || result.breaches.length === 0) return;

  // Only breaches within the user's configured recency window are eligible
  // to trigger (and be described in) the notification - an old breach the
  // domain has long since disclosed shouldn't read as "just happened".
  // "any"/unset means no filtering, so every known breach still qualifies.
  const maxAgeMs = RECENCY_MS[settings.breachNotifyRecency] ?? null;
  const qualifying = maxAgeMs
    ? result.breaches.filter(b => (Date.now() - new Date(b.BreachDate).getTime()) <= maxAgeMs)
    : result.breaches;
  if (qualifying.length === 0) return;

  const cooldownMs   = COOLDOWN_MS[settings.breachNotifyCooldown] ?? COOLDOWN_MS["7d"];
  const notifiedKey  = `hibpNotifiedAt_${domain}`;
  const notifiedData = await new Promise(r => chrome.storage.local.get(notifiedKey, r));
  const lastNotified = notifiedData[notifiedKey] || 0;

  // lastNotified === 0 means this domain has never triggered a notification
  // before, so the first one always goes out regardless of cooldown - the
  // cooldown/"never" setting only governs *repeat* notifications for a
  // domain the user has already been warned about once.
  if (lastNotified > 0) {
    if (cooldownMs === Infinity) return; // "Never remind again" - already notified once, done for good
    if ((Date.now() - lastNotified) < cooldownMs) return;
  }

  // Count and "most recent" are both drawn from the qualifying (filtered)
  // set, not the full breach history - the message should describe what
  // actually triggered this notification, not pad it with older breaches
  // the recency filter deliberately excluded.
  const count = qualifying.length;
  const recentDate = formatBreachDate(mostRecentBreach(qualifying).BreachDate);
  const notificationId = `hibp_${domain}`;

  chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icon128.png",
    title: "Data breach detected",
    message: `${domain} has ${count} known data breach${count === 1 ? "" : "es"}, most recent ${recentDate}. Click to see details.`,
    priority: 1
  });
  notificationTabs.set(notificationId, tabId);

  chrome.storage.local.set({ [notifiedKey]: Date.now() });
}

// Clicking the notification jumps back to the tab that triggered it (if
// still open) and opens the popup there, so the user lands on the same
// breach details they'd see by checking on-demand. openPopup() can fail on
// older Chrome versions or if the window can't be focused - that's caught
// and swallowed since the notification's own text already summarized the
// breach, so there's nothing left to show the user on failure.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);

  const tabId = notificationTabs.get(notificationId);
  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      // Tab was closed since the notification fired - fall through and open
      // the popup on whatever tab is currently active instead.
    }
  }

  try {
    await chrome.action.openPopup();
  } catch (err) {
    console.warn("[PrivacyHub] Could not open popup from notification:", err.message);
  }
});

// ── Core analysis pipeline ───────────────────────────────────────────────────

async function analyzePolicy(links, domain) {
  const texts = [];

  for (const link of links.slice(0, 3)) {
    try {
      console.log(link);
      const res = await fetch(link, { credentials: "omit" });
      if (!res.ok) continue;
      const html = await res.text();
      const text = extractText(html);
      if (text.length > 200) {
        texts.push(text.substring(0, 25000));
      }
    } catch (e) {
      console.warn("[PrivacyHub] Could not fetch policy page:", link, e.message);
    }
  }

  if (texts.length === 0) {
    throw new Error("Could not fetch policy pages. The site may restrict access.");
  }

  const combined = texts.join("\n\n=== NEXT DOCUMENT ===\n\n").substring(0, 50000);
  return await callClaudeAPI(combined);
}

function extractText(html) {
  return html
    .replace(/<(script|style|nav|footer|header|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function callClaudeAPI(policyText) {
  const stored = await chrome.storage.local.get("claudeApiKey");
  const apiKey = stored.claudeApiKey;

  if (!apiKey) {
    throw new Error("No API key configured. Open the extension settings to add your Claude API key.");
  }

  const prompt = `Analyze the following privacy policy and/or terms of service text.

The whole point of this analysis is to give a user something they'll actually
read, instead of the wall of legal text below that they're skipping. Be
ruthlessly concise - every field is shown as a short label or one-liner in a
compact UI, not as prose the user has to work through.

Return ONLY a valid JSON object with exactly this structure (no markdown, no code blocks):
{
  "privacyScore": <integer 1-10>,
  "collectedData": [
    {
      "type": "<specific data type, 1-3 words>",
      "conditional": <boolean - see rules below>,
      "context": "<only if conditional: true, max 5 words>"
    }
  ],
  "thirdParties": [
    {
      "name": "<vendor name - see rules below>",
      "purpose": "<specific purpose, max 4 words>",
      "dataTypes": ["<data shared, 1-3 words each>"]
    }
  ],
  "summary": "<ONE short plain-language sentence, max ~20 words, capturing the single most important takeaway>",
  "concerns": ["<short phrase, max 6 words>", ...],
  "dataDeletion": {
    "method": "<one of: 'account_settings' | 'email_request' | 'contact_form' | 'not_specified'>",
    "instructions": "<short plain-language instructions, max 20 words - see rules below>",
    "contact": "<see rules below>"
  }
}

Rules for "summary": one sentence only, no semicolons stitching multiple
clauses together. Say the one thing a user most needs to know, not a general
overview.

Rules for "concerns": at most 4 items, ordered most severe first. Each one is
a short tag/label like "Sells data to advertisers" or "No deletion option" -
NOT a full sentence or explanation. If there's nothing concerning, return an
empty array rather than padding it with minor items.

Rules for "collectedData": set "conditional": false for anything collected
from any visitor just by using the site normally (email, IP address,
cookies, device info). Set "conditional": true for anything the policy only
mentions collecting when the user takes a specific optional action - applying
for a job, creating an account, making a purchase, subscribing to a
newsletter, contacting support, etc. - and NOT everyone who visits the site.
For conditional items, "context" is a short trigger phrase (max 5 words, no
"if"/"when" needed since the UI adds that) like "apply for a job" or "create
an account". Don't inflate the unconditional list with things that only
apply to a subset of users - a data point that's only ever collected during
a job application must be marked conditional, not lumped in with data
collected from every browsing visitor.

Rules for "thirdParties.name": if the policy text names a specific company
(e.g. "Google Analytics", "Meta", "Stripe"), use that exact name. If it only
describes a vague category with no names given ("advertising partners",
"analytics providers"), don't leave the user with just that label - keep the
category but append 2-3 well-known real-world companies that typically fit
it, clearly marked as illustrative: "Advertising partners (e.g. Google Ads,
Meta, Amazon Ads)". Never present an illustrative example as if the policy
actually named it.

Rules for "dataDeletion": describe how a user can delete their account and/or
personal data at this site, based only on what the policy text actually says.
Set "method" to whichever best matches: "account_settings" if the policy says
users can delete their account/data themselves from account settings;
"email_request" if it says to email/contact privacy or support to request
deletion; "contact_form" if it points to a web form or portal for exercising
this right; "not_specified" if the policy never addresses account/data
deletion at all. Set "instructions" to a short plain-language paraphrase of
what the policy says to do (e.g. "Delete your account from Settings > Privacy"
or "Email privacy@site.com to request deletion") - for "not_specified", use
"Not addressed in this policy - check account settings or contact support.".
Set "contact" to an email address or URL ONLY if one appears verbatim in the
policy text specifically for exercising deletion/erasure rights (copy it
exactly, don't alter or invent one); otherwise use an empty string. Never
fabricate a contact that isn't actually in the text.

Privacy Score Guide:
- 8-10: Minimal data collection, strong user rights (deletion/portability), transparent practices, no data selling, limited 3rd parties
- 5-7: Moderate data collection, some 3rd party sharing for analytics or ads, standard user rights
- 1-4: Extensive data collection, data sold to 3rd parties, many ad partners, weak user controls, long retention

Policy text to analyze:
${policyText}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: "You are a privacy policy analyst. The policy text may be in any language - always analyze it regardless of language. Always respond with valid JSON only - no markdown code blocks, no explanations, just the raw JSON object. All text fields in your response (summary, concerns, collectedData, thirdParties) must be written in English.",
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `Claude API error ${response.status}`);
  }

  const data = await response.json();
  const rawText = data.content?.[0]?.text || "";

  return parseAndValidate(rawText);
}

function getRootDomain(hostname) {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  // Treat common second-level segments (co, com, net…) as part of the TLD
  const secondLevelTLDs = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);
  if (secondLevelTLDs.has(parts[parts.length - 2])) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

function parseAndValidate(text) {
  let parsed;

  // Try direct parse
  try { parsed = JSON.parse(text); }
  catch {
    // Strip possible markdown code fences
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Unexpected response format from Claude.");
    parsed = JSON.parse(match[0]);
  }

  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid response structure.");

  // Normalize fields
  parsed.privacyScore   = Math.min(10, Math.max(1, Math.round(Number(parsed.privacyScore) || 5)));
  parsed.collectedData  = normalizeCollectedData(parsed.collectedData);
  parsed.thirdParties   = Array.isArray(parsed.thirdParties)   ? parsed.thirdParties   : [];
  parsed.concerns       = Array.isArray(parsed.concerns)       ? parsed.concerns       : [];
  parsed.summary        = typeof parsed.summary === "string"   ? parsed.summary        : "";
  parsed.dataDeletion   = normalizeDataDeletion(parsed.dataDeletion);

  return parsed;
}

const DATA_DELETION_METHODS = new Set(["account_settings", "email_request", "contact_form", "not_specified"]);

/**
 * Normalizes "dataDeletion" into the `{ method, instructions, contact }`
 * shape the popup expects. Missing entirely (e.g. a result cached before
 * this field existed) or malformed data both fall back to "not_specified",
 * matching how the prompt itself describes a policy that never addresses
 * deletion - so older cached analyses degrade gracefully instead of showing
 * broken/blank UI.
 * @param {*} raw - The "dataDeletion" value from the parsed response.
 * @returns {{method: string, instructions: string, contact: string}}
 */
function normalizeDataDeletion(raw) {
  const fallback = {
    method: "not_specified",
    instructions: "Not addressed in this policy - check account settings or contact support.",
    contact: ""
  };
  if (!raw || typeof raw !== "object") return fallback;

  const method = DATA_DELETION_METHODS.has(raw.method) ? raw.method : "not_specified";
  const instructions = typeof raw.instructions === "string" && raw.instructions.trim()
    ? raw.instructions.trim()
    : fallback.instructions;
  const contact = typeof raw.contact === "string" ? raw.contact.trim() : "";

  return { method, instructions, contact };
}

/**
 * Normalizes "collectedData" into the `{ type, conditional, context }` shape
 * the popup expects, tolerating anything Claude might actually send back:
 * a bare string (treated as unconditional, matching the old pre-conditional
 * schema), an object missing fields, or a non-boolean "conditional" value.
 * Items that don't yield a usable "type" are dropped.
 * @param {*} raw - The "collectedData" value from the parsed response.
 * @returns {{type: string, conditional: boolean, context: string}[]}
 */
function normalizeCollectedData(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => {
      if (typeof item === "string") {
        return { type: item, conditional: false, context: "" };
      }
      if (item && typeof item === "object") {
        const type = typeof item.type === "string" ? item.type : "";
        const conditional = item.conditional === true;
        const context = conditional && typeof item.context === "string" ? item.context : "";
        return { type, conditional, context };
      }
      return null;
    })
    .filter(item => item && item.type);
}