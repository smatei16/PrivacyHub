// ── Policy page detection ────────────────────────────────────────────────────

function isPolicyPage() {
  const path = window.location.pathname.toLowerCase();
  const keywords = [
    // English
    "privacy", "policy", "terms", "conditions", "tos",
    "terms-of-service", "terms-of-use", "user-agreement", "legal", "tc",
    // French
    "confidentialite", "politique-de-confidentialite", "mentions-legales",
    "conditions-utilisation", "conditions-generales",
    // German
    "datenschutz", "nutzungsbedingungen", "impressum", "agb",
    // Spanish
    "privacidad", "politica-de-privacidad", "terminos", "aviso-legal",
    "condiciones-de-uso",
    // Romanian
    "confidentialitate", "politica-de-confidentialitate", "termeni",
    "conditii", "nota-de-informare",
    // Portuguese
    "privacidade", "politica-de-privacidade", "termos-de-uso",
    "termos-e-condicoes", "aviso-legal"
  ];
  return keywords.some(k => path.includes(k));
}

function findPolicyLinks() {
  const textKeywords = [
    // English
    "privacy policy", "privacy notice", "data policy", "data protection",
    "terms of service", "terms of use", "terms and conditions",
    "terms & conditions", "t&c", "user agreement", "legal notice", "cookie policy",
    // French
    "politique de confidentialité", "politique de confidentialite",
    "avis de confidentialité", "protection des données", "protection des donnees",
    "conditions d'utilisation", "conditions générales", "conditions generales",
    "mentions légales", "mentions legales", "charte de confidentialité",
    // German
    "datenschutzerklärung", "datenschutzerklarung", "datenschutzrichtlinie",
    "nutzungsbedingungen", "allgemeine geschäftsbedingungen", "impressum",
    "cookie-richtlinie", "datenverarbeitung",
    // Spanish
    "política de privacidad", "politica de privacidad",
    "aviso de privacidad", "protección de datos", "proteccion de datos",
    "términos de servicio", "terminos de servicio",
    "términos y condiciones", "terminos y condiciones",
    "aviso legal", "política de cookies", "politica de cookies",
    // Romanian
    "politică de confidențialitate", "politica de confidentialitate",
    "notă de informare", "nota de informare", "protecția datelor",
    "termeni și condiții", "termeni si conditii", "termeni de utilizare",
    "politica de cookie", "acord de utilizare",
    // Portuguese
    "política de privacidade", "politica de privacidade",
    "aviso de privacidade", "proteção de dados", "protecao de dados",
    "termos de serviço", "termos de servico", "termos e condições",
    "termos e condicoes", "aviso legal", "política de cookies"
  ];
  const urlKeywords = [
    // English
    "privacy", "terms", "tos", "legal", "policy", "conditions",
    // French
    "confidentialite", "mentions-legales", "conditions-utilisation",
    // German
    "datenschutz", "nutzungsbedingungen", "impressum",
    // Spanish
    "privacidad", "terminos", "aviso-legal",
    // Romanian
    "confidentialitate", "termeni",
    // Portuguese
    "privacidade", "termos"
  ];

  const seen = new Map();

  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.href;
    if (!href || href.startsWith("javascript:") || href === "#") continue;

    try {
      const linkUrl  = new URL(href);
      const linkPath = linkUrl.pathname.toLowerCase();
      const linkText = anchor.textContent.trim().toLowerCase();

      const byText = textKeywords.some(k => linkText.includes(k));
      const byUrl  = urlKeywords.some(k => linkPath.includes(k));

      if ((byText || byUrl) && !seen.has(href)) {
        seen.set(href, true);
      }
    } catch {
      // skip malformed URLs
    }
  }

  return Array.from(seen.keys());
}

// ── Message handler (popup asks for links) ───────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_POLICY_LINKS") {
    const links = isPolicyPage()
      ? [window.location.href]
      : findPolicyLinks();
    sendResponse({ links });
    return true;
  }
  return true;
});

// ── Auto-detect on page load ──────────────────────────────────────────────────

(function autoDetect() {
  const links = isPolicyPage()
    ? [window.location.href]
    : findPolicyLinks();

  if (links.length > 0) {
    chrome.runtime.sendMessage({
      type: "POLICY_LINKS_FOUND",
      domain: window.location.hostname,
      links
    });
  }
})();


// ── Cookie banner detection (v1 feature, preserved) ──────────────────────────

function findConsentButtonsByText() {
  const keywords = [
    // English
    "accept all", "accept", "agree",
    "reject all", "reject", "refuse", "decline",
    "preferences", "settings", "customize",
    // French
    "tout accepter", "accepter", "accepter tout", "j'accepte",
    "tout refuser", "refuser", "paramètres", "parametres", "personnaliser",
    // German
    "alle akzeptieren", "akzeptieren", "zustimmen",
    "alle ablehnen", "ablehnen", "einstellungen", "anpassen",
    // Spanish
    "aceptar todo", "aceptar", "aceptar todas",
    "rechazar todo", "rechazar", "configuración", "configuracion", "personalizar",
    // Romanian
    "acceptă tot", "accepta tot", "acceptă", "accepta", "sunt de acord",
    "refuz tot", "refuza tot", "refuză", "refuza", "setări", "setari", "personalizează",
    // Portuguese
    "aceitar tudo", "aceitar", "concordar",
    "rejeitar tudo", "rejeitar", "recusar", "preferências", "preferencias", "personalizar"
  ];

  return Array.from(document.querySelectorAll("button, input[type='button'], a, div"))
    .filter(el => {
      const text = el.textContent.trim().toLowerCase();
      return text.length > 0 && text.length < 60 && keywords.some(k => text === k || text.startsWith(k));
    })
    .map(el => ({
      selector: generateUniqueSelector(el),
      label: el.textContent.trim()
    }));
}

function generateUniqueSelector(el) {
  if (!el) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.className && typeof el.className === "string") {
    const classes = el.className.trim().split(/\s+/).filter(Boolean);
    if (classes.length > 0) {
      return `${el.tagName.toLowerCase()}.${classes.map(c => CSS.escape(c)).join(".")}`;
    }
  }
  return el.tagName.toLowerCase();
}

chrome.runtime.sendMessage({ type: "GET_COOKIE_CHOICE", url: window.location.href }, (response) => {
  if (!response?.choice?.selector) {
    const buttonData = findConsentButtonsByText();
    if (buttonData.length > 0) {
      chrome.runtime.sendMessage({
        type: "COOKIE_BANNER_DETECTED",
        url: window.location.href,
        buttons: buttonData
      });
    }
    tryAutoReject();
  }
});

document.addEventListener("click", function(e) {
  const buttonData = findConsentButtonsByText();
  const match = buttonData.find(btn => {
    try { return e.target.matches(btn.selector); } catch { return false; }
  });
  // Guard against false positives: the loose keyword list above matches plenty
  // of ordinary site UI ("Settings", "Accept", "Agree", ...). Only persist the
  // click as "the" cookie choice for this domain if it actually happened inside
  // a cookie/consent banner — otherwise an unrelated click permanently disables
  // auto-reject for the domain (GET_COOKIE_CHOICE would return a stale choice
  // and tryAutoReject() would never run again).
  if (match && isInsideConsentContainer(e.target)) {
    chrome.runtime.sendMessage({
      type: "SAVE_COOKIE_CHOICE",
      url: window.location.href,
      selector: match.selector,
      label: match.label,
      mode: "manual"
    });
  }
}, true);

// ── Auto-reject cookie banners ────────────────────────────────────────────────

// Three tiers ordered by confidence. Lower index = higher priority.
// Tier 0: unambiguous full-reject phrases  → startsWith matching allowed
// Tier 1: "necessary/essential only" phrases → startsWith matching allowed
// Tier 2: generic single-word reject terms  → exact match only (false-positive guard)
const REJECT_TIERS = [
  [
    // English
    "reject all cookies", "reject all", "refuse all cookies", "refuse all",
    "decline all cookies", "decline all", "deny all cookies", "deny all",
    "block all cookies", "block all", "reject cookies", "refuse cookies",
    // French
    "tout refuser", "refuser tout", "rejeter tout", "refuser tous les cookies",
    // German
    "alle cookies ablehnen", "alle ablehnen", "alles ablehnen", "cookies ablehnen",
    // Spanish
    "rechazar todas las cookies", "rechazar todo", "rechazar todas", "rechazar cookies",
    // Romanian
    "refuza toate cookie-urile", "refuza tot", "respinge tot", "refuza toate", "refuză tot", "refuză toate cookie-urile",
    "refuză toate", "refuză cookies", "respingere cookies",
    // Portuguese
    "rejeitar todos os cookies", "rejeitar tudo", "recusar tudo", "recusar todos"
  ],
  [
    // English
    "only necessary cookies", "only necessary", "necessary cookies only", "necessary only",
    "only essential cookies", "only essential", "essential cookies only", "essential only",
    "accept necessary cookies only", "accept only necessary cookies",
    "accept necessary only", "accept only necessary",
    "accept essential only", "accept only essential",
    "use only necessary cookies", "use only necessary",
    "allow necessary only", "allow only necessary",
    // French
    "uniquement les cookies nécessaires", "uniquement nécessaires", "uniquement necessaires",
    "accepter uniquement les nécessaires", "cookies nécessaires uniquement",
    // German
    "nur notwendige cookies", "nur notwendige", "nur erforderliche cookies", "nur erforderliche",
    "notwendige cookies akzeptieren", "nur notwendige cookies akzeptieren",
    // Spanish
    "solo cookies necesarias", "solo las necesarias", "solo necesarias", "solo esenciales",
    "aceptar solo las necesarias", "aceptar solo cookies necesarias",
    // Romanian
    "doar cookie-urile necesare", "doar necesare", "accepta doar necesare",
    "numai cookie-urile necesare",
    // Portuguese
    "apenas cookies necessários", "apenas necessários", "somente necessários",
    "somente cookies necessários", "aceitar apenas necessários"
  ],
  [
    // English — exact match only for single words
    "reject", "refuse", "decline",
    // French
    "refuser", "rejeter",
    // German
    "ablehnen",
    // Spanish
    "rechazar",
    // Romanian
    "refuza", "respinge", "refuză", "refuz",
    // Portuguese
    "rejeitar", "recusar"
  ]
];

// Known CMP/consent platform identifiers and generic consent-related signals.
// Checked against ancestor element id, class name, and aria-label.
const CONSENT_SIGNALS = [
  "cookie", "consent", "gdpr", "ccpa", "rgpd", "eprivacy",
  "cmp", "banner", "notice", "privacy-notice", "cookie-notice",
  "cookie-bar", "cookie-popup", "cookie-modal", "cookie-dialog",
  "cookie-overlay", "cookie-policy", "cookiepolicy",
  // Common CMP vendors
  "onetrust", "cookielaw", "cookiebot", "trustarc", "didomi",
  "quantcast", "evidon", "usercentrics", "cookiepro", "consentmanager",
  "cookieconsent", "cookie-consent", "cookie_consent",
  "termly", "iubenda", "complianz", "borlabs"
];

function isVisible(el) {
  if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity) > 0;
}

function findConsentContainer(el) {
  // Walk up to 8 ancestors looking for CMP/consent signals in id, class, or aria-label.
  // Returns the matched ancestor node, or null if none of the strong signals hit.
  let node = el.parentElement;
  for (let depth = 0; node && node !== document.body && depth < 8; depth++) {
    const id        = (node.id || "").toLowerCase();
    const cls       = (typeof node.className === "string" ? node.className : "").toLowerCase();
    const ariaLabel = (node.getAttribute("aria-label") || "").toLowerCase();
    const role      = (node.getAttribute("role") || "").toLowerCase();

    if (CONSENT_SIGNALS.some(s => id.includes(s) || cls.includes(s) || ariaLabel.includes(s))) {
      return node;
    }
    // dialog/region roles with cookie-related text are strong signals
    if ((role === "dialog" || role === "alertdialog" || role === "region") && depth <= 4) {
      const snippet = node.textContent.slice(0, 600).toLowerCase();
      if (snippet.includes("cookie") || snippet.includes("gdpr") || snippet.includes("consent")) {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}

function isInsideConsentContainer(el) {
  if (findConsentContainer(el)) return true;

  // Last-resort: require the direct parent text to mention cookies AND a consent action,
  // to avoid matching a "Decline" button in unrelated UI.
  const nearby = (el.parentElement?.textContent || "").slice(0, 400).toLowerCase();
  const hasCookieWord  = nearby.includes("cookie") || nearby.includes("gdpr") || nearby.includes("consent");
  const hasActionWord  = nearby.includes("accept") || nearby.includes("reject") ||
                         nearby.includes("decline") || nearby.includes("preference");
  return hasCookieWord && hasActionWord;
}

function findBestRejectButton() {
  const candidates = Array.from(
    document.querySelectorAll("button, [role='button'], input[type='button'], a")
  ).filter(el => isVisible(el));

  let bestEl   = null;
  let bestTier = Infinity;

  for (const el of candidates) {
    const text = el.textContent.trim().toLowerCase();
    if (!text || text.length > 90) continue;

    for (let t = 0; t < REJECT_TIERS.length; t++) {
      if (t >= bestTier) break; // can't improve on what we already have
      const isExactOnly = t === 2; // tier 2: single words, exact match only
      const matched = REJECT_TIERS[t].some(k =>
        isExactOnly ? text === k : (text === k || text.startsWith(k))
      );
      if (matched && isInsideConsentContainer(el)) {
        bestEl   = el;
        bestTier = t;
        break;
      }
    }

    if (bestTier === 0) break; // can't do better than tier 0
  }

  return bestEl;
}

// ── Notice-only banners (no reject option offered) ───────────────────────────
//
// Some banners — common on government/university/institutional sites — only
// inform you that cookies are used and offer a single acknowledgment button
// ("OK", "Accept", "Got it", ...) with no way to decline. There's no privacy
// choice being given up by dismissing these, so it's worth clearing them out
// of the way too. We only do this when findBestRejectButton() has already
// failed AND the banner has no "Manage/Customize/Preferences" escape hatch —
// if one exists, a real reject option may be one click deeper, so we leave it
// alone rather than risk silently accepting full tracking.

const MANAGE_KEYWORDS = [
  // English
  "preferences", "settings", "customize", "customise", "manage",
  "manage cookies", "manage preferences", "cookie settings", "more options",
  // French
  "paramètres", "parametres", "personnaliser", "gérer", "gerer",
  // German
  "einstellungen", "anpassen", "verwalten",
  // Spanish
  "configuración", "configuracion", "personalizar", "gestionar",
  // Romanian
  "setări", "setari", "personalizează", "personalizeaza", "gestionează", "gestioneaza",
  // Portuguese
  "preferências", "preferencias", "gerenciar"
];

// Neutral, non-committal wording preferred when a banner offers more than one
// acknowledgment-style button (e.g. both "Accept" and "Close") — clicking any
// of them has the same effect since there's no real choice, but "close"/"got
// it" reads less like an affirmative privacy decision than "accept".
const NEUTRAL_ACK_WORDS = [
  "ok", "okay", "got it", "close", "dismiss", "continue", "understood",
  "compris", "d'accord", "fermer", "continuer",
  "verstanden", "schließen", "weiter",
  "entendido", "de acuerdo", "cerrar", "continuar",
  "am înțeles", "am inteles", "de acord", "închide", "inchide", "continuă", "continua", "sunt de acord",
  "entendi", "fechar"
];

const ACK_KEYWORDS = [
  ...NEUTRAL_ACK_WORDS,
  // English
  "accept", "accept all", "accept cookies", "i understand", "i agree", "agree", "allow", "allow all",
  // French
  "j'ai compris", "j'accepte", "tout accepter", "accepter",
  // German
  "akzeptieren", "alle akzeptieren", "einverstanden",
  // Spanish
  "aceptar", "aceptar todo",
  // Romanian
  "accept", "accepta", "accept tot",
  // Portuguese
  "concordo", "aceitar", "aceitar tudo"
];

function findAcknowledgeButton() {
  const candidates = Array.from(
    document.querySelectorAll("button, [role='button'], input[type='button'], a")
  ).filter(el => isVisible(el));

  // Group candidates by the consent container they belong to, so a "Manage
  // preferences" link in one banner can't block dismissal of an unrelated
  // banner elsewhere on the page.
  const containers = new Map();

  for (const el of candidates) {
    const text = el.textContent.trim().toLowerCase();
    if (!text || text.length > 90) continue;

    const container = findConsentContainer(el);
    if (!container) continue;

    if (!containers.has(container)) containers.set(container, { ackEls: [], hasManage: false });
    const entry = containers.get(container);

    if (MANAGE_KEYWORDS.some(k => text === k || text.startsWith(k))) entry.hasManage = true;
    if (ACK_KEYWORDS.some(k => text === k)) entry.ackEls.push(el);
  }

  for (const entry of containers.values()) {
    if (entry.hasManage || entry.ackEls.length === 0) continue; // escape hatch to a real choice — leave it alone
    const neutral = entry.ackEls.find(el => NEUTRAL_ACK_WORDS.includes(el.textContent.trim().toLowerCase()));
    return neutral || entry.ackEls[0];
  }

  return null;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function tryAutoReject() {
  chrome.storage.local.get("autoRejectCookies", (data) => {
    if (!data.autoRejectCookies) return;

    let rejected = false;
    let observer = null; // declared before attemptClick so the closure can safely reference it

    function attemptClick() {
      if (rejected) return;

      const rejectBtn = findBestRejectButton();
      if (rejectBtn) {
        rejected = true;
        observer?.disconnect();
        rejectBtn.click();
        chrome.runtime.sendMessage({
          type: "SAVE_COOKIE_CHOICE",
          url: window.location.href,
          selector: generateUniqueSelector(rejectBtn),
          label: rejectBtn.textContent.trim(),
          mode: "reject"
        });
        return;
      }

      // No reject option anywhere on the page. If there's a banner that's a
      // pure notice — no decline button and no "manage preferences" path to
      // one — dismiss it too, since there's nothing privacy-preserving to lose.
      const ackBtn = findAcknowledgeButton();
      if (!ackBtn) return;
      rejected = true;
      observer?.disconnect();
      ackBtn.click();
      chrome.runtime.sendMessage({
        type: "SAVE_COOKIE_CHOICE",
        url: window.location.href,
        selector: generateUniqueSelector(ackBtn),
        label: ackBtn.textContent.trim(),
        mode: "acknowledge"
      });
    }

    // Try immediately (covers banners already in the DOM at document_end)
    attemptClick();
    if (rejected) return;

    // Watch for dynamically injected banners (10-second window)
    observer = new MutationObserver(debounce(attemptClick, 250));
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer?.disconnect(), 10000);
  });
}