// In-memory set to track active analyses (survives only for SW lifetime)
const pendingAnalyses = new Set();

// Cookie-choice messages can now arrive from any frame on the page (content.js
// runs with all_frames: true so it can reach cookie banners rendered inside
// cross-origin CMP iframes). message.url is that frame's own URL — inside an
// iframe that's the CMP vendor's domain, not the site the user is on. Prefer
// sender.tab.url (the tab's actual address-bar URL) so choices are always
// filed under the site itself, regardless of which frame handled the banner.
function pageDomainFor(message, sender) {
  const pageUrl = sender.tab?.url || message.url;
  return new URL(pageUrl).hostname;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Policy link storage ──────────────────────────────────────────────────
  if (message.type === "POLICY_LINKS_FOUND") {
    const domain = message.domain;
    chrome.storage.local.get(`links_${domain}`, (data) => {
      if (!data[`links_${domain}`] || data[`links_${domain}`].length === 0) {
        chrome.storage.local.set({ [`links_${domain}`]: message.links });
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
    const { domain, links } = message;

    if (pendingAnalyses.has(domain)) {
      sendResponse({ ok: true });
      return true;
    }

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
    const { domain } = message;
    const HIBP_TTL  = 7 * 24 * 60 * 60 * 1000; // 7 days

    (async () => {
      try {
        const cacheKey = `hibp_${domain}`;
        const stored   = await new Promise(r => chrome.storage.local.get([cacheKey, "hibpApiKey"], r));
        const apiKey   = stored.hibpApiKey;

        if (!apiKey) { sendResponse({ status: "no_key" }); return; }

        const cached = stored[cacheKey];
        if (cached && (Date.now() - cached.fetchedAt) < HIBP_TTL) {
          sendResponse({ status: "done", breaches: cached.breaches });
          return;
        }

        const rootDomain = getRootDomain(domain);
        const res = await fetch(
          `https://haveibeenpwned.com/api/v3/breaches?domain=${encodeURIComponent(rootDomain)}`,
          { headers: { "hibp-api-key": apiKey, "user-agent": "PrivacyHub/2.0" } }
        );

        if (res.status === 401) {
          sendResponse({ status: "error", message: "Invalid HIBP API key." });
          return;
        }
        if (!res.ok && res.status !== 404) {
          sendResponse({ status: "error", message: `HIBP API returned ${res.status}.` });
          return;
        }

        const breaches = res.ok ? await res.json() : [];
        chrome.storage.local.set({ [cacheKey]: { breaches, fetchedAt: Date.now() } });
        sendResponse({ status: "done", breaches });
      } catch (err) {
        sendResponse({ status: "error", message: err.message });
      }
    })();

    return true;
  }

  return true;
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
ruthlessly concise — every field is shown as a short label or one-liner in a
compact UI, not as prose the user has to work through.

Return ONLY a valid JSON object with exactly this structure (no markdown, no code blocks):
{
  "privacyScore": <integer 1-10>,
  "collectedData": [
    {
      "type": "<specific data type, 1-3 words>",
      "conditional": <boolean — see rules below>,
      "context": "<only if conditional: true, max 5 words>"
    }
  ],
  "thirdParties": [
    {
      "name": "<vendor name — see rules below>",
      "purpose": "<specific purpose, max 4 words>",
      "dataTypes": ["<data shared, 1-3 words each>"]
    }
  ],
  "summary": "<ONE short plain-language sentence, max ~20 words, capturing the single most important takeaway>",
  "concerns": ["<short phrase, max 6 words>", ...]
}

Rules for "summary": one sentence only, no semicolons stitching multiple
clauses together. Say the one thing a user most needs to know, not a general
overview.

Rules for "concerns": at most 4 items, ordered most severe first. Each one is
a short tag/label like "Sells data to advertisers" or "No deletion option" —
NOT a full sentence or explanation. If there's nothing concerning, return an
empty array rather than padding it with minor items.

Rules for "collectedData": set "conditional": false for anything collected
from any visitor just by using the site normally (email, IP address,
cookies, device info). Set "conditional": true for anything the policy only
mentions collecting when the user takes a specific optional action — applying
for a job, creating an account, making a purchase, subscribing to a
newsletter, contacting support, etc. — and NOT everyone who visits the site.
For conditional items, "context" is a short trigger phrase (max 5 words, no
"if"/"when" needed since the UI adds that) like "apply for a job" or "create
an account". Don't inflate the unconditional list with things that only
apply to a subset of users — a data point that's only ever collected during
a job application must be marked conditional, not lumped in with data
collected from every browsing visitor.

Rules for "thirdParties.name": if the policy text names a specific company
(e.g. "Google Analytics", "Meta", "Stripe"), use that exact name. If it only
describes a vague category with no names given ("advertising partners",
"analytics providers"), don't leave the user with just that label — keep the
category but append 2-3 well-known real-world companies that typically fit
it, clearly marked as illustrative: "Advertising partners (e.g. Google Ads,
Meta, Amazon Ads)". Never present an illustrative example as if the policy
actually named it.

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
      system: "You are a privacy policy analyst. The policy text may be in any language — always analyze it regardless of language. Always respond with valid JSON only — no markdown code blocks, no explanations, just the raw JSON object. All text fields in your response (summary, concerns, collectedData, thirdParties) must be written in English.",
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

  return parsed;
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