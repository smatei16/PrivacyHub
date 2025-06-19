let lastSummary = {};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "POLICY_DETECTED") {
        fetch("http://127.0.0.1:8000/analyze", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({text: message.text})
        })
        .then(response => response.json())
        .then(result => {
            lastSummary = {
                found: true,
                dataCollected: result.data_collected || [],
                purposes: result.purposes || []
            };
            console.log("Policy page detected at:", message.url);
            console.log("Extracted text:", message.text.substring(0, 500));
            sendResponse(lastSummary);
        })
        .catch(e => {
            lastSummary = {found: false};
            sendResponse({found: false});
        });
        return true;
    }

    if (message.type === "GET_POLICY_SUMMARY") {
        sendResponse(lastSummary && lastSummary.found ? lastSummary : {found: false});
        return true;
    }

    if (message.type === "COOKIE_BANNER_DETECTED") {
        const domain = new URL(message.url).hostname;
        chrome.storage.local.get(["cookie_choices"], (data) => {
            const choices = data.cookie_choices || {};
            if (!choices[domain]) {
                choices[domain] = {
                    detectedButtons: message.buttons
                };
                chrome.storage.local.set({ cookie_choices: choices }, () => {
                    sendResponse();
                });
                console.log("Cookie banner detected and stored for:", domain);
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
            choices[domain].selected = {
                selector: message.selector,
                label: message.label
            };
            chrome.storage.local.set({ cookie_choices: choices }, () => {
                console.log("Saved cookie preference for:", domain, message.label);
                sendResponse();
            });
        });
        return true;
    }

    return true;
});
