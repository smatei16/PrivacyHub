// In-memory set to track active analyses (survives only for SW lifetime)
const pendingAnalyses = new Set();

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
    const domain = new URL(message.url).hostname;
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
    const domain = new URL(message.url).hostname;
    chrome.storage.local.get(["cookie_choices"], (data) => {
      const choice = data.cookie_choices?.[domain]?.selected || null;
      sendResponse({ choice });
    });
    return true;
  }

  if (message.type === "SAVE_COOKIE_CHOICE") {
    const domain = new URL(message.url).hostname;
    chrome.storage.local.get(["cookie_choices"], (data) => {
      const choices = data.cookie_choices || {};
      if (!choices[domain]) choices[domain] = {};
      choices[domain].selected = { selector: message.selector, label: message.label };
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

Return ONLY a valid JSON object with exactly this structure (no markdown, no code blocks):
{
  "privacyScore": <integer 1-10>,
  "collectedData": ["<specific data type>", ...],
  "thirdParties": [
    {
      "name": "<vendor name>",
      "purpose": "<specific purpose>",
      "dataTypes": ["<data shared>"]
    }
  ],
  "summary": "<2-3 sentence plain-language overview of key privacy practices>",
  "concerns": ["<top concern 1>", "<top concern 2>", ...]
}

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
  parsed.collectedData  = Array.isArray(parsed.collectedData)  ? parsed.collectedData  : [];
  parsed.thirdParties   = Array.isArray(parsed.thirdParties)   ? parsed.thirdParties   : [];
  parsed.concerns       = Array.isArray(parsed.concerns)       ? parsed.concerns       : [];
  parsed.summary        = typeof parsed.summary === "string"   ? parsed.summary        : "";

  return parsed;
}