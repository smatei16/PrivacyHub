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
  }
});

document.addEventListener("click", function(e) {
  const buttonData = findConsentButtonsByText();
  const match = buttonData.find(btn => {
    try { return e.target.matches(btn.selector); } catch { return false; }
  });
  if (match) {
    chrome.runtime.sendMessage({
      type: "SAVE_COOKIE_CHOICE",
      url: window.location.href,
      selector: match.selector,
      label: match.label
    });
  }
}, true);