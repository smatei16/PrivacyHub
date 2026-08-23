/**
 * cookie-consent.js
 * ────────────────────────────────────────────────────────────────────────
 * Detects cookie/GDPR consent banners and, when the user has enabled
 * auto-reject in Options, automatically resolves them - preferring a real
 * "Reject All" (or "Necessary Only"), opening a "Manage preferences" panel
 * to find one if it's not on the initial banner, and as a last resort
 * dismissing pure-notice banners that offer no way to decline at all.
 *
 * Runs in every frame (manifest.json: all_frames), unlike
 * policy-detection.js - a cookie banner rendered inside a cross-origin CMP
 * iframe (Sourcepoint, Quantcast Choice, ...) is only reachable if this
 * script runs there too.
 *
 * Depends on the constants defined in consent-keywords.js, which must load
 * first (see manifest.json's content_scripts order).
 */

// ── Shared helpers ────────────────────────────────────────────────────────

/**
 * Reads a clickable element's effective label. Plain <button>/<a> elements
 * carry it in textContent, but <input> elements never do - their label
 * lives in `value` (or, for accessibility, `aria-label`). Icon-only buttons
 * on other sites often skip visible text entirely and rely on aria-label
 * too, so falling back to those keeps every matcher below working on
 * elements with no text node children at all.
 * @param {Element} el
 * @returns {string} The element's best-effort visible/accessible label, or "" if none.
 */
function getButtonLabel(el) {
  const text = el.textContent.trim();
  if (text) return text;
  if (typeof el.value === "string" && el.value.trim()) return el.value.trim();
  return (el.getAttribute("aria-label") || "").trim();
}

/**
 * Builds a CSS selector that identifies `el` well enough for bookkeeping
 * (the SAVE_COOKIE_CHOICE record) - not guaranteed unique, and never used
 * to re-locate and re-click the element later; it's purely a human-readable
 * trace of "this is roughly what got clicked".
 * @param {Element|null} el
 * @returns {string|null}
 */
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

// ── Cookie banner detection (v1 feature, preserved) ──────────────────────

/**
 * Legacy (v1) loose consent-button detector, kept for two purposes: telling
 * the popup which buttons look like consent controls (COOKIE_BANNER_DETECTED,
 * below) and recognizing a user's own manual click on one (see the click
 * listener below) so their choice gets remembered too. Uses a broader,
 * unscoped keyword list than the auto-reject engine further down -
 * deliberately, since a false *detection* here is harmless, whereas a false
 * *auto-click* isn't (that's what isInsideConsentContainer, further down,
 * guards against for the auto-reject path).
 * @returns {{selector: string, label: string}[]}
 */
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

  return Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], a, div"))
    .filter(el => {
      const text = getButtonLabel(el).toLowerCase();
      return text.length > 0 && text.length < 60 && keywords.some(k => text === k || text.startsWith(k));
    })
    .map(el => ({
      selector: generateUniqueSelector(el),
      label: getButtonLabel(el)
    }));
}

// ── Bootstrap: ask background whether this domain already has a saved choice ──
//
// If it does, we're done - GET_COOKIE_CHOICE's domain is resolved from
// sender.tab.url in background.js, so this correctly checks the *site's*
// saved choice even when this particular frame is a cross-origin CMP
// iframe. Otherwise, report any consent-looking buttons found (for the
// popup) and let the auto-reject engine below have a go.
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

// ── Track the user's own manual clicks on a consent button ────────────────
document.addEventListener("click", function(e) {
  const buttonData = findConsentButtonsByText();
  const match = buttonData.find(btn => {
    try { return e.target.matches(btn.selector); } catch { return false; }
  });
  // Guard against false positives: the loose keyword list above matches plenty
  // of ordinary site UI ("Settings", "Accept", "Agree", ...). Only persist the
  // click as "the" cookie choice for this domain if it actually happened inside
  // a cookie/consent banner - otherwise an unrelated click permanently disables
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

// ── Auto-reject engine ─────────────────────────────────────────────────────

/**
 * @param {Element} el
 * @returns {boolean} True if `el` is actually rendered and visible on
 * screen (not display:none, visibility:hidden, zero-sized, or fully
 * transparent).
 */
function isVisible(el) {
  if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity) > 0;
}

/**
 * Walks up to 8 ancestors from `el` looking for a strong signal that we're
 * inside a cookie-consent widget: a known CMP vendor name or generic
 * consent-related word in an ancestor's id/class/aria-label (CONSENT_SIGNALS),
 * or an ARIA dialog/alertdialog/region role whose own text mentions
 * cookies/GDPR/consent. No extra depth cap on the role check beyond the
 * walk's own limit - a real ARIA dialog role combined with cookie-related
 * text is specific enough on its own that ignoring it past a few levels
 * only creates false negatives (Google's own cookie dialog, for example,
 * wraps its buttons 7 levels deep).
 * @param {Element} el
 * @returns {Element|null} The matched ancestor, or null if none of the strong signals hit.
 */
function findConsentContainer(el) {
  let node = el.parentElement;
  for (let depth = 0; node && node !== document.body && depth < 8; depth++) {
    const id        = (node.id || "").toLowerCase();
    const cls       = (typeof node.className === "string" ? node.className : "").toLowerCase();
    const ariaLabel = (node.getAttribute("aria-label") || "").toLowerCase();
    const role      = (node.getAttribute("role") || "").toLowerCase();

    if (CONSENT_SIGNALS.some(s => id.includes(s) || cls.includes(s) || ariaLabel.includes(s))) {
      return node;
    }
    if (role === "dialog" || role === "alertdialog" || role === "region") {
      const snippet = node.textContent.slice(0, 3000).toLowerCase();
      if (snippet.includes("cookie") || snippet.includes("gdpr") || snippet.includes("consent")) {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * The safety gate every auto-reject/auto-dismiss candidate must pass before
 * it's clicked: is `el` actually inside something that looks like a cookie
 * banner, not just some unrelated button whose label happens to match one
 * of our keyword lists?
 *
 * Tries findConsentContainer() first. Failing that, Google's own domains
 * (GOOGLE_DOMAIN_RE) get a more permissive fallback: Google's cookie
 * prompts carry no CMP-style container signal at all - plain markup with
 * generic class names, no dialog role on the full-page prompt since the
 * whole page *is* the prompt, and buttons that are sometimes <input
 * value="..."> elements whose value never shows up in any ancestor's
 * textContent. That fallback walks a few more ancestors with a longer text
 * window and the full keyword vocabulary (REJECT_TIERS + ACK_KEYWORDS +
 * MANAGE_KEYWORDS) instead of just cookie+accept/reject/decline/preference.
 * It's scoped strictly to google.* domains so this broader check can't fire
 * on arbitrary sites.
 *
 * Every other domain instead falls back to a tight check: does the
 * button's *immediate* parent's text mention cookies AND an accept/reject/
 * decline/preference word?
 * @param {Element} el
 * @returns {boolean}
 */
function isInsideConsentContainer(el) {
  if (findConsentContainer(el)) return true;

  if (GOOGLE_DOMAIN_RE.test(window.location.hostname)) {
    const actionWords = [...REJECT_TIERS.flat(), ...ACK_KEYWORDS, ...MANAGE_KEYWORDS];
    let node = el.parentElement;
    for (let depth = 0; node && node !== document.body && depth < 5; depth++) {
      const nearby = node.textContent.slice(0, 800).toLowerCase();
      const hasCookieWord = nearby.includes("cookie") || nearby.includes("gdpr") || nearby.includes("consent");
      if (hasCookieWord && actionWords.some(w => nearby.includes(w))) return true;
      node = node.parentElement;
    }
    return false;
  }

  // Last-resort: require the direct parent text to mention cookies AND a consent action,
  // to avoid matching a "Decline" button in unrelated UI.
  const nearby = (el.parentElement?.textContent || "").slice(0, 400).toLowerCase();
  const hasCookieWord  = nearby.includes("cookie") || nearby.includes("gdpr") || nearby.includes("consent");
  const hasActionWord  = nearby.includes("accept") || nearby.includes("reject") ||
                         nearby.includes("decline") || nearby.includes("preference");
  return hasCookieWord && hasActionWord;
}

/**
 * Scans every visible clickable element on the page and returns the single
 * best "Reject All" / "Necessary Only" candidate - the one matching the
 * highest-confidence REJECT_TIERS entry among those that also pass
 * isInsideConsentContainer(). Returns null if nothing qualifies.
 * @returns {Element|null}
 */
function findBestRejectButton() {
  const candidates = Array.from(
    document.querySelectorAll(CLICKABLE_SELECTOR)
  ).filter(el => isVisible(el));

  let bestEl   = null;
  let bestTier = Infinity;

  for (const el of candidates) {
    const text = getButtonLabel(el).toLowerCase();
    if (!text || text.length > 90) continue;

    for (let t = 0; t < REJECT_TIERS.length; t++) {
      if (t >= bestTier) break; // can't improve on what we already have
      const isExactOnly = t === 2; // tier 2: single words, exact match only
      const matched = REJECT_TIERS[t].some(k =>
        isExactOnly ? text === k : text.includes(k)
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

// ── Notice-only banners (no reject option offered) ───────────────────────
//
// Some banners - common on government/university/institutional sites - only
// inform you that cookies are used and offer a single acknowledgment button
// ("OK", "Accept", "Got it", ...) with no way to decline. There's no privacy
// choice being given up by dismissing these, so it's worth clearing them out
// of the way too. We only do this when findBestRejectButton() has already
// failed AND the banner has no "Manage/Customize/Preferences" escape hatch -
// if one exists, a real reject option may be one click deeper, so we leave it
// alone rather than risk silently accepting full tracking.

/**
 * Finds a genuine acknowledgment-only button to dismiss a pure-notice
 * banner with - one that offers no way to decline at all. Only called
 * after findBestRejectButton() and findManageButton() have both already
 * failed to find anything to click.
 *
 * Groups candidates by the consent container they belong to (so a "Manage
 * preferences" link in one banner can't block dismissal of an unrelated
 * banner elsewhere on the page), and skips any container that also has a
 * manage/customize escape hatch - a real reject option may be one click
 * deeper there, so it's left alone rather than silently accepted.
 * @returns {Element|null}
 */
function findAcknowledgeButton() {
  const candidates = Array.from(
    document.querySelectorAll(CLICKABLE_SELECTOR)
  ).filter(el => isVisible(el));

  const containers = new Map();

  for (const el of candidates) {
    const text = getButtonLabel(el).toLowerCase();
    if (!text || text.length > 90) continue;

    const container = findConsentContainer(el);
    if (!container) continue;

    if (!containers.has(container)) containers.set(container, { ackEls: [], hasManage: false });
    const entry = containers.get(container);

    // .includes() rather than startsWith/exact: real buttons often phrase the
    // manage-keyword mid-sentence rather than as the whole label, e.g. "Vreau
    // să modific setările individual" ("I want to modify settings individually").
    if (MANAGE_KEYWORDS.some(k => text.includes(k))) entry.hasManage = true;
    if (ACK_KEYWORDS.some(k => text === k)) entry.ackEls.push(el);
  }

  for (const entry of containers.values()) {
    if (entry.hasManage || entry.ackEls.length === 0) continue; // escape hatch to a real choice - leave it alone
    const neutral = entry.ackEls.find(el => NEUTRAL_ACK_WORDS.includes(getButtonLabel(el).toLowerCase()));
    return neutral || entry.ackEls[0];
  }

  return null;
}

/**
 * Finds a "Manage/Customize preferences" link inside a consent container.
 * Some CMPs (this project's original OneTrust test case among them) only
 * expose "Reject All" one click deeper, inside the panel that link opens -
 * the initial banner offers only Accept and this link. tryAutoReject()
 * clicks it once and then re-scans for a real reject button once the
 * panel's contents land in the DOM.
 * @returns {Element|null}
 */
function findManageButton() {
  const candidates = Array.from(
    document.querySelectorAll(CLICKABLE_SELECTOR)
  ).filter(el => isVisible(el));

  for (const el of candidates) {
    const text = getButtonLabel(el).toLowerCase();
    if (!text || text.length > 90) continue;
    if (!findConsentContainer(el)) continue;
    if (MANAGE_KEYWORDS.some(k => text.includes(k))) return el;
  }

  return null;
}

/**
 * Standard trailing-edge debounce: delays calling `fn` until `ms`
 * milliseconds have passed without another call. Used to coalesce the
 * burst of DOM mutations a CMP script produces while rendering its banner
 * into a single re-scan instead of one per mutation.
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

/**
 * The auto-reject entry point, called once per page load (see the
 * bootstrap above) after confirming no choice is already saved for this
 * domain. Does nothing unless the user has enabled "Auto-reject cookie
 * banners" in Options.
 *
 * On each attempt (immediately, then on every DOM mutation for up to 10
 * seconds, to catch banners that render asynchronously):
 *   1. Try to find and click a real reject button (findBestRejectButton).
 *   2. Failing that, and only once, try opening a "Manage preferences"
 *      panel (findManageButton) - the mutation this triggers feeds back
 *      into step 1 on the next attempt, since the panel may reveal a real
 *      reject button.
 *   3. Failing that too, dismiss a pure-notice banner if one is found
 *      (findAcknowledgeButton) - there's nothing privacy-preserving to
 *      lose if no decline path was ever offered.
 *
 * Whichever button ends up clicked, the choice is reported to
 * background.js via SAVE_COOKIE_CHOICE (with a `mode` of "reject" or
 * "acknowledge") so this domain isn't re-processed on the next page load.
 */
function tryAutoReject() {
  chrome.storage.local.get("autoRejectCookies", (data) => {
    if (!data.autoRejectCookies) return;

    let rejected = false;
    let manageClicked = false; // guards against repeatedly reopening the same panel
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
          label: getButtonLabel(rejectBtn),
          mode: "reject"
        });
        return;
      }

      // No reject button visible yet. Many CMPs (OneTrust among them) only
      // expose "Reject All" inside a "Manage/Customize preferences" panel,
      // not on the initial banner. Open it once and keep watching - the
      // MutationObserver below will re-run this function when the panel's
      // contents land in the DOM, and the reject-button search above will
      // then have something to find.
      if (!manageClicked) {
        const manageBtn = findManageButton();
        if (manageBtn) {
          manageClicked = true;
          manageBtn.click();
          return; // don't disconnect - stay watching for the panel to open
        }
      }

      // Still nothing: no reject button, and no (further) manage panel to
      // try. If it's a pure notice - no decline path at all - dismiss it
      // instead, since there's nothing privacy-preserving to lose.
      const ackBtn = findAcknowledgeButton();
      if (!ackBtn) return;
      rejected = true;
      observer?.disconnect();
      ackBtn.click();
      chrome.runtime.sendMessage({
        type: "SAVE_COOKIE_CHOICE",
        url: window.location.href,
        selector: generateUniqueSelector(ackBtn),
        label: getButtonLabel(ackBtn),
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