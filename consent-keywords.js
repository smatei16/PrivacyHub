/**
 * consent-keywords.js
 * ────────────────────────────────────────────────────────────────────────
 * Pure data used by cookie-consent.js to recognize and act on cookie/GDPR
 * consent banners: the multilingual phrase lists used to classify a
 * button's label, the CSS selector for "things that might be a clickable
 * button", and the id/class/domain fingerprints used to confirm a matched
 * button actually sits inside something that looks like a cookie banner.
 *
 * No logic lives here — just constants — so new languages or phrases can be
 * added without touching the matching engine in cookie-consent.js. Must be
 * loaded before cookie-consent.js (see manifest.json's content_scripts
 * order); policy-detection.js doesn't use any of this.
 */

/**
 * Anything that might act as a clickable consent control. Includes
 * input[type=submit] because some real-world buttons — Google's own
 * full-page cookie prompt among them — use <input> rather than <button>/<a>.
 */
const CLICKABLE_SELECTOR = "button, [role='button'], input[type='button'], input[type='submit'], a";

/**
 * Reject-button phrases, grouped into three confidence tiers (index 0 is
 * most confident). findBestRejectButton() in cookie-consent.js walks the
 * tiers in order and takes the best match found anywhere on the page.
 *
 *  - Tier 0: unambiguous full-reject phrases ("reject all cookies").
 *  - Tier 1: "necessary/essential only" phrases — functionally a reject of
 *    everything but strictly-required cookies.
 *  - Tier 2: generic single words ("reject", "decline") — matched by exact
 *    equality only (see findBestRejectButton), since as loose substrings
 *    they'd false-positive on unrelated UI far too easily.
 *
 * Tiers 0 and 1 are matched with .includes() rather than a stricter
 * startsWith/exact check — they're specific multi-word phrases, so matching
 * them as a substring (not just a prefix) catches real buttons that wrap
 * the phrase in extra text (icons, aria-label leftovers, a leading emoji)
 * without meaningfully raising the false-positive risk.
 */
const REJECT_TIERS = [
  [
    // English
    "reject all cookies", "reject all", "refuse all cookies", "refuse all",
    "decline all cookies", "decline all", "deny all cookies", "deny all",
    "block all cookies", "block all", "reject cookies", "refuse cookies",
    "decline optional cookies",
    // French
    "tout refuser", "refuser tout", "rejeter tout", "refuser tous les cookies",
    // German
    "alle cookies ablehnen", "alle ablehnen", "alles ablehnen", "cookies ablehnen",
    // Spanish
    "rechazar todas las cookies", "rechazar todo", "rechazar todas", "rechazar cookies",
    // Romanian — infinitive/short forms ("Refuza tot") and formal imperative
    // plural forms ("Respingeți toate", common on buttons phrased as a request
    // to the user, e.g. OneTrust's Romanian preference-center translation)
    "refuza toate cookie-urile", "refuza tot", "respinge tot", "refuza toate",
    "refuză tot", "refuză toate cookie-urile", "refuză toate", "refuză cookies",
    "respingere cookies", "respingeți toate", "respingeți tot",
    "refuzați toate cookie-urile", "refuzați toate", "refuzați tot",
    "resping toate", "resping tot",
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
    "refuza", "respinge", "refuză", "refuz", "respingeți", "refuzați",
    // Portuguese
    "rejeitar", "recusar"
  ]
];

/**
 * Known CMP (consent-management platform) vendor names and generic
 * consent-related words. Checked against an ancestor element's id, class
 * name, and aria-label by findConsentContainer() to confirm a matched
 * button actually sits inside something that looks like a cookie banner,
 * not just anywhere on the page.
 */
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

/**
 * Matches google.com and its country-TLD variants (google.ro, google.co.uk,
 * …) and any subdomain of them (consent.google.com, accounts.google.de, …),
 * while rejecting lookalikes that merely contain "google" (google-evil.com,
 * notgoogle.com) since "google." must be preceded by the string start or a
 * literal dot. Used to scope a more permissive container-detection fallback
 * (see isInsideConsentContainer in cookie-consent.js) to Google's own
 * domains only — Google's cookie prompts carry no CMP-style container
 * signal at all, unlike virtually every third-party CMP.
 */
const GOOGLE_DOMAIN_RE = /(^|\.)google\.[a-z.]+$/i;

/**
 * "Manage/customize preferences" phrases — the escape hatch some CMPs put
 * in place of an on-banner reject option, requiring one more click to reach
 * a real "Reject All" inside a preferences panel (this project's original
 * OneTrust test case worked this way). Used two ways in cookie-consent.js:
 * findManageButton() opens this link when no reject button exists yet, and
 * findAcknowledgeButton() refuses to auto-accept a banner that has one,
 * since a real reject option may be one click deeper.
 */
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
  "personalizează modulele cookie",
  // Portuguese
  "preferências", "preferencias", "gerenciar"
];

/**
 * Neutral, non-committal acknowledgment wording ("OK", "Got it", "Close").
 * Preferred by findAcknowledgeButton() over "Accept"-flavored wording when
 * a pure-notice banner offers more than one acknowledgment button —
 * clicking either has the same effect since there's no real choice being
 * made, but "close"/"got it" reads less like an affirmative privacy
 * decision than "accept".
 */
const NEUTRAL_ACK_WORDS = [
  "ok", "okay", "got it", "close", "dismiss", "continue", "understood",
  "compris", "d'accord", "fermer", "continuer",
  "verstanden", "schließen", "weiter",
  "entendido", "de acuerdo", "cerrar", "continuar",
  "am înțeles", "am inteles", "de acord", "închide", "inchide", "continuă", "continua", "sunt de acord",
  "entendi", "fechar"
];

/**
 * Full acknowledgment-button vocabulary (NEUTRAL_ACK_WORDS plus explicit
 * "Accept"-style wording). Matched by exact equality only in
 * findAcknowledgeButton() — unlike REJECT_TIERS' looser substring matching,
 * a false positive here means clicking "Accept" and granting full tracking
 * consent, so this stays deliberately conservative.
 */
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