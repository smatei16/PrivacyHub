// Helper to render lists
function renderList(elementId, items) {
    const el = document.getElementById(elementId);
    el.innerHTML = '';
    if (!items || items.length === 0) {
        el.innerHTML = '<li><em>None detected</em></li>';
        return;
    }
    items.forEach(item => {
        const li = document.createElement('li');
        li.textContent = item;
        el.appendChild(li);
    });
}

// Show saved cookie preference
function showCookiePreference(domain) {
    chrome.runtime.sendMessage({ type: "GET_COOKIE_CHOICE", url: "https://" + domain }, (response) => {
        const prefDiv = document.getElementById('cookie-pref');
        if (response && response.choice && response.choice.label) {
            prefDiv.innerHTML = `<b>Saved Cookie Preference:</b> <span style="color:#2d3a4b">${response.choice.label}</span>`;
        } else {
            prefDiv.innerHTML = `<b>Saved Cookie Preference:</b> <span style="color:#888">None</span>`;
        }
    });
}

// Request summary from background
chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    let responded = false;
    // Show loading status immediately
    document.getElementById('status').classList.remove('hidden');
    document.getElementById('summary').classList.add('hidden');
    document.getElementById('no-policy').classList.add('hidden');

    // Set domain display
    let domain = '';
    try {
        const url = new URL(tabs[0].url);
        domain = url.hostname;
        document.getElementById('domain').textContent = domain;
    } catch {
        document.getElementById('domain').textContent = '';
    }

    // Always show cookie preference (even if summary not loaded yet)
    showCookiePreference(domain);

    // Set a timeout to handle slow/no response
    const timeout = setTimeout(() => {
        if (!responded) {
            document.getElementById('status').classList.add('hidden');
            document.getElementById('no-policy').classList.remove('hidden');
        }
    }, 8000); // 8 seconds fallback

    chrome.runtime.sendMessage({type: "GET_POLICY_SUMMARY", tabId: tabs[0].id}, (response) => {
        responded = true;
        clearTimeout(timeout);
        document.getElementById('status').classList.add('hidden');
        if (response && response.found) {
            document.getElementById('summary').classList.remove('hidden');
            renderList('data-list', response.dataCollected);
            renderList('purpose-list', response.purposes);
        } else {
            document.getElementById('no-policy').classList.remove('hidden');
        }
    });
});