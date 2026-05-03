import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "ST-MessageAutoRetry";
const extensionTitle = "ST Message Auto Retry";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const retryHeaderName = "X-ST-Message-Auto-Retry";

const defaultSettings = {
    enabled: true,
    retryDelaySeconds: 5,
};

function ensureSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }

    const settings = extension_settings[extensionName];
    let changed = false;

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = value;
            changed = true;
        }
    }

    const normalizedEnabled = Boolean(settings.enabled);
    if (settings.enabled !== normalizedEnabled) {
        settings.enabled = normalizedEnabled;
        changed = true;
    }

    const delay = Number(settings.retryDelaySeconds);
    const normalizedDelay = Number.isFinite(delay) && delay >= 0 ? Math.round(delay) : defaultSettings.retryDelaySeconds;
    if (settings.retryDelaySeconds !== normalizedDelay) {
        settings.retryDelaySeconds = normalizedDelay;
        changed = true;
    }

    return changed;
}

function isRequestObject(value) {
    return typeof Request !== "undefined" && value instanceof Request;
}

function getRequestUrl(input) {
    if (typeof input === "string") {
        return input;
    }

    if (isRequestObject(input) || (input && typeof input === "object" && typeof input.url === "string")) {
        return input.url;
    }

    return null;
}

function isGenerationUrl(url) {
    if (!url) {
        return false;
    }

    try {
        const parsed = new URL(url, window.location.href);
        return parsed.pathname.endsWith("/generate") || parsed.pathname.endsWith("/chat/completions");
    } catch {
        return url.includes("/generate") || url.includes("/chat/completions");
    }
}

function isGenerationRequest(input) {
    return isGenerationUrl(getRequestUrl(input));
}

function getDelayMs() {
    const seconds = Number(extension_settings[extensionName]?.retryDelaySeconds ?? defaultSettings.retryDelaySeconds);
    return Math.max(0, seconds) * 1000;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function showRetryToast(seconds, attemptNumber) {
    if (typeof toastr?.info !== "function") {
        return;
    }

    toastr.info(
        `Retry attempt ${attemptNumber} is starting after ${seconds} second${seconds === 1 ? "" : "s"}.`,
        extensionTitle,
        { preventDuplicates: true },
    );
}

function buildReplayableRequest(args) {
    try {
        return new Request(args[0], args[1]);
    } catch (error) {
        console.warn(`[${extensionName}] Could not create replayable request.`, error);
        return null;
    }
}

function isRetryRequest(input) {
    return isRequestObject(input) && input.headers?.get(retryHeaderName) === "1";
}

function createRetryRequest(request) {
    const headers = new Headers(request.headers);
    headers.set(retryHeaderName, "1");
    return new Request(request, { headers });
}

function createRetryArgs(originalArgs, replayableRequest) {
    const [input, init] = originalArgs;

    if (typeof input === "string") {
        const nextInit = { ...(init ?? {}) };
        const headers = new Headers(nextInit.headers ?? replayableRequest.headers);
        headers.set(retryHeaderName, "1");
        nextInit.headers = headers;
        return [input, nextInit];
    }

    return [createRetryRequest(replayableRequest.clone())];
}

function updateSetting(key, value) {
    extension_settings[extensionName][key] = value;
    saveSettingsDebounced();
}

function loadSettings() {
    const changed = ensureSettings();
    const settings = extension_settings[extensionName];

    $("#st_message_auto_retry_enabled").prop("checked", settings.enabled);
    $("#st_message_auto_retry_delay").val(settings.retryDelaySeconds);

    if (changed) {
        saveSettingsDebounced();
    }
}

function bindSettings() {
    $("#st_message_auto_retry_enabled").off("change.stMessageAutoRetry").on("change.stMessageAutoRetry", function () {
        updateSetting("enabled", Boolean(this.checked));
    });

    $("#st_message_auto_retry_delay").off("change.stMessageAutoRetry input.stMessageAutoRetry").on("change.stMessageAutoRetry input.stMessageAutoRetry", function () {
        const value = Number.parseFloat(String(this.value));
        if (Number.isFinite(value) && value >= 0) {
            updateSetting("retryDelaySeconds", value);
        }
    });
}

async function loadSettingsUi() {
    if (document.getElementById("st-message-auto-retry-settings")) {
        return;
    }

    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings2").append(settingsHtml);
}

async function handleRetry(response, replayableRequest, originalFetch, thisArg, originalArgs) {
    const settings = extension_settings[extensionName] ?? defaultSettings;

    if (!settings.enabled || response.status !== 429) {
        return response;
    }

    const delayMs = getDelayMs();
    let currentResponse = response;
    let attemptNumber = 1;

    while (currentResponse.status === 429) {
        if (replayableRequest.signal?.aborted) {
            return currentResponse;
        }

        if (delayMs > 0) {
            await sleep(delayMs);
        }

        if (replayableRequest.signal?.aborted) {
            return currentResponse;
        }

        showRetryToast(delayMs / 1000, attemptNumber);

        try {
            const retryArgs = createRetryArgs(originalArgs, replayableRequest);
            currentResponse = await originalFetch.apply(thisArg, retryArgs);
            attemptNumber += 1;
        } catch (error) {
            console.warn(`[${extensionName}] Retry failed.`, error);
            return currentResponse;
        }
    }

    return currentResponse;
}

function installFetchInterceptor() {
    if (window.__st_message_auto_retry_original_fetch__) {
        return;
    }

    window.__st_message_auto_retry_original_fetch__ = window.fetch;

    window.fetch = async function (...args) {
        if (isRetryRequest(args[0])) {
            return window.__st_message_auto_retry_original_fetch__.apply(this, args);
        }

        if (!isGenerationRequest(args[0])) {
            return window.__st_message_auto_retry_original_fetch__.apply(this, args);
        }

        const replayableRequest = buildReplayableRequest(args);
        if (!replayableRequest) {
            return window.__st_message_auto_retry_original_fetch__.apply(this, args);
        }

        const response = await window.__st_message_auto_retry_original_fetch__.apply(this, args);
        return handleRetry(response, replayableRequest, window.__st_message_auto_retry_original_fetch__, this, args);
    };
}

function init() {
    ensureSettings();

    void loadSettingsUi()
        .then(() => {
            loadSettings();
            bindSettings();
        })
        .catch((error) => console.error(`[${extensionName}] Failed to load settings UI.`, error));
    installFetchInterceptor();
}

$(init);
