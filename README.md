# ST Message Auto Retry

Automatically retries generation requests until SillyTavern receives a non-429 response.

## Installation

1. Open SillyTavern
2. Click **Extensions** → **Install Extension**
3. Paste this URL: https://github.com/MakksSh/ST-MessageAutoRetry
4. Click **Install**
5. **Refresh** the page

## Settings

- **Enable auto retry**: turns the retry behavior on or off.
- **Retry delay in seconds**: waits this long before the retry is sent.
- **Enable debug mode**: stores compact request traces so you can inspect the browser-visible response.
- **Keep last N logs**: limits how many debug traces are stored in the local ring buffer.
- **Open debug log**: shows the human-readable debug trace viewer inside the extension drawer.
- **Copy logs**: copies the latest raw JSON traces to the clipboard.
- **Clear logs**: removes the stored debug traces.

## Behavior

- Intercepts only generation requests that currently match `/generate` and `/chat/completions`.
- If a generation request returns HTTP 429 and auto retry is enabled, the extension waits the configured delay, shows a toast when each retry starts, and resends the same request.
- The extension also retries 5xx responses when the response body clearly indicates an upstream 429 or quota exhaustion payload.
- The extension keeps retrying while the response remains HTTP 429, or while a 5xx response still carries that 429-like payload.
- Debug mode records the request URL, route-match decision, HTTP status, content type, compact body preview, effective retry delay, retry timing, and final retry decision.

## Debug notes

- Debug logs are stored in the browser, not in the SillyTavern server terminal.
- This is useful for diagnosing cases where the upstream provider returns 429 but the browser-facing response seen by the extension is something else, such as 200 or 500.
- For safety, the debug viewer stores only a compact response preview instead of the full body.

## Limitation

- The extension stops retrying if the original request is aborted or if the retry attempt fails before a response is received.
