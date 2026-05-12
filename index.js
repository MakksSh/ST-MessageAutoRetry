import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "ST-MessageAutoRetry";
const extensionTitle = "ST Message Auto Retry";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const retryHeaderName = "X-ST-Message-Auto-Retry";
const debugStorageKey = `${extensionName}:debugLogs`;
const maxBodyPreviewLength = 1500;
const maxClipboardLogCount = 100;

const defaultSettings = {
    enabled: true,
    retryDelaySeconds: 5,
    debugMode: false,
    maxDebugLogs: 20,
};

let requestSequence = 0;
let debugLogs = loadDebugLogsFromStorage();

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

    const normalizedDebugMode = Boolean(settings.debugMode);
    if (settings.debugMode !== normalizedDebugMode) {
        settings.debugMode = normalizedDebugMode;
        changed = true;
    }

    const maxLogs = Number(settings.maxDebugLogs);
    const normalizedMaxLogs = Number.isFinite(maxLogs) && maxLogs >= 1 ? Math.min(200, Math.round(maxLogs)) : defaultSettings.maxDebugLogs;
    if (settings.maxDebugLogs !== normalizedMaxLogs) {
        settings.maxDebugLogs = normalizedMaxLogs;
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

function getRequestMethod(input, init) {
    const method = init?.method ?? input?.method;
    return typeof method === "string" && method.trim() ? method.toUpperCase() : "GET";
}

function classifyGenerationUrl(url) {
    if (!url) {
        return { matched: false, matchedBy: null, pathname: null };
    }

    try {
        const parsed = new URL(url, window.location.href);
        const { pathname } = parsed;
        if (pathname.endsWith("/generate")) {
            return { matched: true, matchedBy: "/generate", pathname };
        }

        if (pathname.endsWith("/chat/completions")) {
            return { matched: true, matchedBy: "/chat/completions", pathname };
        }

        return { matched: false, matchedBy: null, pathname };
    } catch {
        if (url.includes("/generate")) {
            return { matched: true, matchedBy: "/generate", pathname: null };
        }

        if (url.includes("/chat/completions")) {
            return { matched: true, matchedBy: "/chat/completions", pathname: null };
        }

        return { matched: false, matchedBy: null, pathname: null };
    }
}

function isPotentialGenerationRequest(url, method) {
    if (!url || method !== "POST") {
        return false;
    }

    return url.includes("/api/backends/") || url.includes("/generate") || url.includes("/completions");
}

function getDelayMs() {
    const seconds = Number(extension_settings[extensionName]?.retryDelaySeconds ?? defaultSettings.retryDelaySeconds);
    return Math.max(0, seconds) * 1000;
}

function getMaxDebugLogs() {
    const maxLogs = Number(extension_settings[extensionName]?.maxDebugLogs ?? defaultSettings.maxDebugLogs);
    return Number.isFinite(maxLogs) && maxLogs >= 1 ? Math.min(200, Math.round(maxLogs)) : defaultSettings.maxDebugLogs;
}

function isDebugEnabled() {
    return Boolean(extension_settings[extensionName]?.debugMode);
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

function showStatusToast(level, message) {
    const handler = toastr?.[level];
    if (typeof handler !== "function") {
        return;
    }

    handler(message, extensionTitle, { preventDuplicates: true });
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

function getInputShape(input) {
    if (typeof input === "string") {
        return "string+init";
    }

    if (isRequestObject(input)) {
        return "request";
    }

    return "unknown";
}

function nextRequestId() {
    requestSequence += 1;
    return `mar_${String(requestSequence).padStart(4, "0")}`;
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
    $("#st_message_auto_retry_debug_enabled").prop("checked", settings.debugMode);
    $("#st_message_auto_retry_debug_max_logs").val(settings.maxDebugLogs);

    renderDebugUi();

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

    $("#st_message_auto_retry_debug_enabled").off("change.stMessageAutoRetry").on("change.stMessageAutoRetry", function () {
        const enabled = Boolean(this.checked);
        updateSetting("debugMode", enabled);
        if (enabled) {
            appendDebugLog({
                type: "session_start",
                ts: new Date().toISOString(),
                extension: extensionName,
                settings: {
                    enabled: Boolean(extension_settings[extensionName]?.enabled),
                    retryDelaySeconds: Number(extension_settings[extensionName]?.retryDelaySeconds ?? defaultSettings.retryDelaySeconds),
                    debugMode: true,
                    maxDebugLogs: getMaxDebugLogs(),
                },
            });
        }
        renderDebugUi();
    });

    $("#st_message_auto_retry_debug_max_logs").off("change.stMessageAutoRetry input.stMessageAutoRetry").on("change.stMessageAutoRetry input.stMessageAutoRetry", function () {
        const value = Number.parseFloat(String(this.value));
        if (Number.isFinite(value) && value >= 1) {
            updateSetting("maxDebugLogs", value);
            trimDebugLogs();
            renderDebugUi();
        }
    });

    $("#st_message_auto_retry_debug_toggle").off("click.stMessageAutoRetry").on("click.stMessageAutoRetry", function () {
        const panel = $("#st_message_auto_retry_debug_panel");
        const isVisible = panel.is(":visible");
        panel.toggle(!isVisible);
        $(this).text(isVisible ? "Open debug log" : "Hide debug log");
    });

    $("#st_message_auto_retry_debug_copy").off("click.stMessageAutoRetry").on("click.stMessageAutoRetry", async () => {
        const rawLogs = debugLogs.slice(-maxClipboardLogCount);
        const payload = JSON.stringify(rawLogs, null, 2);
        const copied = await copyTextToClipboard(payload);
        if (copied) {
            showStatusToast("success", "Debug logs copied.");
        } else {
            showStatusToast("error", "Could not copy debug logs.");
        }
    });

    $("#st_message_auto_retry_debug_clear").off("click.stMessageAutoRetry").on("click.stMessageAutoRetry", () => {
        debugLogs = [];
        persistDebugLogs();
        renderDebugUi();
        showStatusToast("info", "Debug logs cleared.");
    });
}

async function copyTextToClipboard(text) {
    if (navigator?.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            return false;
        }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    document.body.append(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    let copied = false;
    try {
        copied = document.execCommand("copy");
    } catch {
        copied = false;
    }

    textarea.remove();
    return copied;
}

async function loadSettingsUi() {
    if (document.getElementById("st-message-auto-retry-settings")) {
        return;
    }

    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings2").append(settingsHtml);
}

function loadDebugLogsFromStorage() {
    try {
        const rawValue = window.localStorage?.getItem(debugStorageKey);
        if (!rawValue) {
            return [];
        }

        const parsed = JSON.parse(rawValue);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function persistDebugLogs() {
    try {
        window.localStorage?.setItem(debugStorageKey, JSON.stringify(debugLogs));
    } catch (error) {
        console.warn(`[${extensionName}] Could not persist debug logs.`, error);
    }
}

function trimDebugLogs() {
    const maxLogs = getMaxDebugLogs();
    if (debugLogs.length > maxLogs) {
        debugLogs = debugLogs.slice(-maxLogs);
        persistDebugLogs();
    }
}

function appendDebugLog(logEntry) {
    debugLogs.push(logEntry);
    trimDebugLogs();
    persistDebugLogs();
    renderDebugUi();
}

function renderDebugUi() {
    const panel = $("#st_message_auto_retry_debug_panel");
    if (!panel.length) {
        return;
    }

    const logCount = debugLogs.length;
    const lastLog = debugLogs[logCount - 1] ?? null;
    const summaryLines = [
        `Logs stored: ${logCount}`,
        `Debug mode: ${isDebugEnabled() ? "on" : "off"}`,
    ];

    if (lastLog?.type === "request_trace") {
        summaryLines.push(`Last decision: ${lastLog.finalDecision} (${lastLog.finalReason})`);
        const lastAttempt = lastLog.attempts?.[lastLog.attempts.length - 1] ?? null;
        if (lastAttempt) {
            summaryLines.push(`Last response: ${lastAttempt.responseStatus} ${lastAttempt.contentType ? `, ${lastAttempt.contentType}` : ""}`);
        }
    } else if (lastLog?.type === "session_start") {
        summaryLines.push("Last event: debug session started");
    }

    $("#st_message_auto_retry_debug_summary").text(summaryLines.join(" | "));
    $("#st_message_auto_retry_debug_output").val(formatDebugLogsForDisplay(debugLogs));
}

function formatDebugLogsForDisplay(logEntries) {
    if (!logEntries.length) {
        return "No debug logs captured yet.";
    }

    return logEntries.map(formatDebugLogEntry).join("\n\n");
}

function formatDebugLogEntry(logEntry) {
    if (logEntry.type === "session_start") {
        return `[${formatTimestamp(logEntry.ts)}] Debug session started | retry=${logEntry.settings?.enabled ? "on" : "off"} | delay=${logEntry.settings?.retryDelaySeconds ?? "?"}s | keep=${logEntry.settings?.maxDebugLogs ?? "?"}`;
    }

    if (logEntry.type !== "request_trace") {
        return JSON.stringify(logEntry);
    }

    const lines = [
        `[${formatTimestamp(logEntry.ts)}] ${logEntry.method} ${logEntry.url ?? "[unknown url]"}`,
        `requestId: ${logEntry.requestId} | matched: ${logEntry.isGenerationRequest ? `yes (${logEntry.matchedBy})` : "no"} | shape: ${logEntry.inputShape}`,
    ];

    for (const attempt of logEntry.attempts ?? []) {
        lines.push(`attempt ${attempt.attempt} (${attempt.phase}): status=${attempt.responseStatus} ok=${attempt.responseOk} type=${attempt.contentType || "[none]"}`);
        if (attempt.bodyHas429Signal) {
            lines.push("body signal: detected 429-like content");
        }
        if (attempt.bodyPreview) {
            lines.push(`body preview: ${attempt.bodyPreview}`);
        }
        if (attempt.retryTriggered) {
            lines.push(`retry: yes (${attempt.retryReason})`);
        } else if (attempt.retryReason) {
            lines.push(`retry: no (${attempt.retryReason})`);
        }
    }

    if (logEntry.errorMessage) {
        lines.push(`error: ${logEntry.errorMessage}`);
    }

    lines.push(`final: ${logEntry.finalDecision} (${logEntry.finalReason})`);
    return lines.join("\n");
}

function formatTimestamp(value) {
    if (!value) {
        return "unknown time";
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function buildTrace(args, matchResult) {
    const [input, init] = args;
    const url = getRequestUrl(input);
    return {
        type: "request_trace",
        ts: new Date().toISOString(),
        requestId: nextRequestId(),
        url,
        method: getRequestMethod(input, init),
        inputShape: getInputShape(input),
        isGenerationRequest: matchResult.matched,
        matchedBy: matchResult.matchedBy,
        attempts: [],
        requestAborted: Boolean(input?.signal?.aborted || init?.signal?.aborted),
        finalDecision: null,
        finalReason: null,
    };
}

function detect429Signal(text) {
    if (typeof text !== "string" || !text.trim()) {
        return false;
    }

    const normalized = text.toLowerCase();
    return normalized.includes('"code":429')
        || normalized.includes('"code": 429')
        || normalized.includes("too many requests")
        || normalized.includes("resource_exhausted")
        || normalized.includes("resource has been exhausted");
}

function shouldRetryResponse(response, responseDetails = null) {
    if (response.status === 429) {
        return {
            shouldRetry: true,
            reason: "http_429",
        };
    }

    if (response.status >= 500 && response.status < 600 && responseDetails?.bodyHas429Signal) {
        return {
            shouldRetry: true,
            reason: `http_${response.status}_with_429_payload`,
        };
    }

    return {
        shouldRetry: false,
        reason: `http_status_${response.status}`,
    };
}

function sanitizePreview(text) {
    if (typeof text !== "string" || !text.length) {
        return "";
    }

    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= maxBodyPreviewLength) {
        return compact;
    }

    return `${compact.slice(0, maxBodyPreviewLength)}…`;
}

async function inspectResponse(response) {
    const contentType = response.headers.get("content-type") ?? "";
    const details = {
        responseStatus: response.status,
        responseOk: response.ok,
        contentType,
        bodyPreview: "",
        bodyHas429Signal: false,
        bodyReadError: null,
    };

    const lowerContentType = contentType.toLowerCase();
    if (lowerContentType.includes("text/event-stream")) {
        details.bodyPreview = "[event stream skipped]";
        return details;
    }

    const canReadBody = lowerContentType.includes("application/json")
        || lowerContentType.includes("text/")
        || lowerContentType.includes("application/problem+json")
        || lowerContentType.includes("application/xml")
        || lowerContentType.includes("application/x-www-form-urlencoded");

    if (!canReadBody) {
        return details;
    }

    try {
        const bodyText = await response.clone().text();
        details.bodyPreview = sanitizePreview(bodyText);
        details.bodyHas429Signal = detect429Signal(bodyText);
    } catch (error) {
        details.bodyPreview = "[unavailable]";
        details.bodyReadError = error instanceof Error ? error.message : String(error);
    }

    return details;
}

function buildSkippedTrace(trace, reason) {
    return {
        ...trace,
        finalDecision: "skipped",
        finalReason: reason,
    };
}

async function recordAttempt(trace, response, phase, attemptNumber, retryTriggered, retryReason, responseDetails = null) {
    const details = responseDetails ?? await inspectResponse(response);
    trace.attempts.push({
        attempt: attemptNumber,
        phase,
        ...details,
        retryTriggered,
        retryReason,
    });

    return details;
}

function commitTrace(trace, shouldLog) {
    if (shouldLog) {
        appendDebugLog(trace);
    }
}

async function handleRetry(response, replayableRequest, originalFetch, thisArg, originalArgs, trace, shouldLog) {
    const settings = extension_settings[extensionName] ?? defaultSettings;
    const shouldInspectInitialResponse = shouldLog || (settings.enabled && response.status >= 500 && response.status < 600);
    const initialDetails = shouldInspectInitialResponse ? await inspectResponse(response) : null;
    const initialRetryDecision = shouldRetryResponse(response, initialDetails);
    const initialShouldRetry = settings.enabled && initialRetryDecision.shouldRetry;
    if (shouldLog) {
        await recordAttempt(trace, response, "initial", 0, initialShouldRetry, initialRetryDecision.reason, initialDetails);
    }

    if (!settings.enabled || !initialShouldRetry) {
        if (shouldLog) {
            trace.finalDecision = settings.enabled ? "no_retry" : "disabled";
            trace.finalReason = settings.enabled ? `response_status_${response.status}` : "auto_retry_disabled";
            commitTrace(trace, shouldLog);
        }
        return response;
    }

    const delayMs = getDelayMs();
    let currentResponse = response;
    let attemptNumber = 1;

    while (true) {
        if (replayableRequest.signal?.aborted) {
            trace.requestAborted = true;
            trace.finalDecision = "stopped";
            trace.finalReason = "request_aborted_before_retry";
            commitTrace(trace, shouldLog);
            return currentResponse;
        }

        if (delayMs > 0) {
            await sleep(delayMs);
        }

        if (replayableRequest.signal?.aborted) {
            trace.requestAborted = true;
            trace.finalDecision = "stopped";
            trace.finalReason = "request_aborted_after_wait";
            commitTrace(trace, shouldLog);
            return currentResponse;
        }

        showRetryToast(delayMs / 1000, attemptNumber);

        try {
            const retryArgs = createRetryArgs(originalArgs, replayableRequest);
            currentResponse = await originalFetch.apply(thisArg, retryArgs);
            const shouldInspectRetryResponse = shouldLog || currentResponse.status >= 500 && currentResponse.status < 600;
            const retryDetails = shouldInspectRetryResponse ? await inspectResponse(currentResponse) : null;
            const retryDecision = shouldRetryResponse(currentResponse, retryDetails);
            if (shouldLog) {
                await recordAttempt(trace, currentResponse, "retry", attemptNumber, retryDecision.shouldRetry, retryDecision.reason, retryDetails);
            }
            attemptNumber += 1;

            if (!retryDecision.shouldRetry) {
                break;
            }
        } catch (error) {
            console.warn(`[${extensionName}] Retry failed.`, error);
            if (shouldLog) {
                trace.errorMessage = error instanceof Error ? error.message : String(error);
                trace.finalDecision = "retry_failed";
                trace.finalReason = "network_or_wrapper_error";
                commitTrace(trace, shouldLog);
            }
            return currentResponse;
        }
    }

    if (shouldLog) {
        trace.finalDecision = attemptNumber > 1 ? "success_after_retry" : "success";
        trace.finalReason = "received_non_429_response";
        commitTrace(trace, shouldLog);
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

        const [input, init] = args;
        const url = getRequestUrl(input);
        const method = getRequestMethod(input, init);
        const matchResult = classifyGenerationUrl(url);
        const debugEnabled = isDebugEnabled();

        if (!matchResult.matched) {
            if (debugEnabled && isPotentialGenerationRequest(url, method)) {
                appendDebugLog(buildSkippedTrace(buildTrace(args, matchResult), "url_not_matched"));
            }
            return window.__st_message_auto_retry_original_fetch__.apply(this, args);
        }

        const replayableRequest = buildReplayableRequest(args);
        if (!replayableRequest) {
            if (debugEnabled) {
                appendDebugLog(buildSkippedTrace(buildTrace(args, matchResult), "request_not_replayable"));
            }
            return window.__st_message_auto_retry_original_fetch__.apply(this, args);
        }

        const trace = buildTrace(args, matchResult);

        try {
            const response = await window.__st_message_auto_retry_original_fetch__.apply(this, args);
            if (debugEnabled) {
                return handleRetry(response, replayableRequest, window.__st_message_auto_retry_original_fetch__, this, args, trace, true);
            }

            const settings = extension_settings[extensionName] ?? defaultSettings;
            const canContainRetryableQuotaPayload = response.status === 429 || (response.status >= 500 && response.status < 600);
            if (!settings.enabled || !canContainRetryableQuotaPayload) {
                return response;
            }

            return handleRetry(response, replayableRequest, window.__st_message_auto_retry_original_fetch__, this, args, trace, false);
        } catch (error) {
            if (debugEnabled) {
                trace.errorMessage = error instanceof Error ? error.message : String(error);
                trace.finalDecision = "request_failed";
                trace.finalReason = "initial_fetch_error";
                appendDebugLog(trace);
            }
            throw error;
        }
    };
}

function init() {
    ensureSettings();
    trimDebugLogs();

    void loadSettingsUi()
        .then(() => {
            loadSettings();
            bindSettings();
        })
        .catch((error) => console.error(`[${extensionName}] Failed to load settings UI.`, error));
    installFetchInterceptor();
}

$(init);
