// POLICY ANALYSIS

// detect if the current page is a privacy policy or terms of service page
function isPolicyPage() {
    const url = window.location.href.toLowerCase();
    const keywords = ['privacy', 'policy', 'terms', 'conditions', 'tc', 't&c', 'terms of service', 'terms of use', 'user agreement'];
    return keywords.some(k => url.includes(k));
}

// Find all links that likely point to privacy policies or terms of service
function findPolicyLinks() {
    const keywords = [
        'privacy', 'policy', 'terms', 'conditions', 'tc', 't&c',
        'terms of service', 'terms of use', 'user agreement'
    ];
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const matches = anchors.filter(a => {
        const text = a.textContent.toLowerCase();
        return keywords.some(k => text.includes(k));
    });
    const urls = [...new Set(matches.map(a => a.href))];
    return urls;
}

// Try to find policy links if not on a policy page
if (!isPolicyPage()) {
    const policyLinks = findPolicyLinks();
    console.log(policyLinks);
    if (policyLinks.length > 0) {
        // Fetch the policy page, extract text, and send to background
        fetch(policyLinks[0])
            .then(res => res.text())
            .then(html => {
                const doc = new DOMParser().parseFromString(html, "text/html");
                const text = doc.body ? doc.body.innerText : '';
                chrome.runtime.sendMessage({
                    type: "POLICY_DETECTED",
                    text: text,
                    sourceUrl: window.location.href
                }, (summary) => {
                    if (summary && summary.found) {
                        showOverlay(summary);
                    }
                });
            })
            .catch(e => {
                console.warn("Could not fetch or parse policy page:", e);
            });
    }
} else {
    const policyText = document.body.innerText
    // Send to background or popup for NLP processing
    chrome.runtime.sendMessage({
        type: "POLICY_DETECTED",
        text: policyText,
        url: window.location.href
    }, (summary) => {
        if (summary && summary.found) {
            showOverlay(summary);
        }
    });
}


// Show overlay with summary of privacy policy
function showOverlay(summary) {
    // Remove existing overlay if present
    const old = document.getElementById('privacy-hub-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'privacy-hub-overlay';
    overlay.style.position = 'fixed';
    overlay.style.bottom = '20px';
    overlay.style.right = '20px';
    overlay.style.zIndex = '999999';
    overlay.style.background = '#fff';
    overlay.style.border = '1px solid #ccc';
    overlay.style.borderRadius = '8px';
    overlay.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
    overlay.style.padding = '16px 20px';
    overlay.style.maxWidth = '320px';
    overlay.style.fontFamily = 'Segoe UI, Arial, sans-serif';
    overlay.style.fontSize = '14px';
    overlay.style.color = '#222';

    overlay.innerHTML = `
        <strong>Privacy Policy Summary</strong>
        <div style="margin-top:8px;">
            <b>Data Collected:</b>
            <ul style="margin:4px 0 8px 16px;padding:0;">
                ${summary.dataCollected.map(item => `<li>${item}</li>`).join('')}
            </ul>
            <b>Purposes:</b>
            <ul style="margin:4px 0 0 16px;padding:0;">
                ${summary.purposes.map(item => `<li>${item}</li>`).join('')}
            </ul>
        </div>
        <button id="privacy-hub-close" style="margin-top:10px;float:right;background:#eee;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;">Close</button>
    `;

    document.body.appendChild(overlay);

    document.getElementById('privacy-hub-close').onclick = () => overlay.remove();
}


// COOKIE BANNER DETECTION

// Detect cookie consent buttons based on common keywords
function findConsentButtonsByText() {
    const keywords = [
        'accept all', 'accept', 'agree',
        'reject all', 'reject', 'refuse', 'decline',
        'preferences', 'settings', 'customize'
    ];

    const elements = Array.from(document.querySelectorAll("button, input[type='button'], a, div"))
        .filter(el => {
            const text = el.textContent.trim().toLowerCase();
            return text.length > 0 && keywords.some(k => text.includes(k));
        });

    // Returnează sub formă de selector și label
    return elements.map(el => ({
        selector: generateUniqueSelector(el),
        label: el.textContent.trim()
    }));
}


// Cookie Banner Handling
chrome.runtime.sendMessage({ type: "GET_COOKIE_CHOICE", url: window.location.href }, (response) => {
    const choice = response?.choice;
    if (choice?.selector) {
        const btn = document.querySelector(choice.selector);
        if (btn) {
            console.log("Saved cookie preference:", choice.label);
        }
    } else {
        const buttonData = findConsentButtonsByText();
        console.log(buttonData);
        chrome.runtime.sendMessage({
            type: "COOKIE_BANNER_DETECTED",
            url: window.location.href,
            buttons: buttonData
        });
    }
});

// Listen for clicks on detected consent buttons and save the user's choice
document.addEventListener('click', function (e) {
    const buttonData = findConsentButtonsByText();
    const clickedEl = e.target;
    const match = buttonData.find(btn => {
        try {
            return clickedEl.matches(btn.selector);
        } catch {
            return false;
        }
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

// Generate a unique selector for an element
function generateUniqueSelector(el) {
    if (!el) return null;
    if (el.id) return `#${el.id}`;
    if (el.className) {
        const classSelector = el.className.toString().split(" ").map(cls => `.${cls}`).join("");
        return `${el.tagName.toLowerCase()}${classSelector}`;
    }
    return el.tagName.toLowerCase();
}