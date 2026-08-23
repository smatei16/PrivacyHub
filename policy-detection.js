/**
 * policy-detection.js
 * ────────────────────────────────────────────────────────────────────────
 * Finds links to (or detects the current page as) a privacy policy or
 * terms-of-service page, so the popup/background pipeline can fetch and
 * analyze that text with Claude. Runs top-frame only (see isTopFrame below)
 * - a page's own privacy policy is a property of the page, not of whatever
 * ad/embed iframes happen to be on it.
 */

/**
 * True only in the top-level frame of the tab, false inside any iframe.
 *
 * With all_frames enabled (manifest.json), this content script now also
 * runs inside every iframe on the page - including cross-origin
 * cookie-consent widgets (Sourcepoint, Quantcast Choice, etc.) that live in
 * their own frame and were previously unreachable. Policy/T&C link
 * detection below only makes sense for the page the user is actually
 * looking at, not for unrelated ad/embed iframes, so it's gated to the top
 * frame. Cookie-banner detection and auto-reject (cookie-consent.js)
 * intentionally run in every frame instead.
 */
const isTopFrame = window.top === window.self;

/**
 * True if the current page's own URL path looks like a privacy/terms page
 * (e.g. "/privacy-policy", "/terms-of-use") in any of the supported
 * languages - in which case the page itself, not a link on it, is what
 * should get analyzed.
 * @returns {boolean}
 */
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

/**
 * Scans every link on the page and returns the href of each one that looks
 * like it points to a privacy policy / terms-of-service / cookie policy
 * page, judged by the link's visible text and/or its URL path.
 * @returns {string[]} Deduplicated list of matching absolute URLs, in the order first seen.
 */
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

if (isTopFrame) {
  // ── Message handler (popup asks for links) ───────────────────────────────
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

  // ── Auto-detect on page load ──────────────────────────────────────────────
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
}