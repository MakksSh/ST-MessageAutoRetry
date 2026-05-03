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

## Behavior

- Intercepts only generation requests, such as `/generate` and `/chat/completions`.
- If a generation request returns HTTP 429 and auto retry is enabled, the extension waits the configured delay, shows a toast when each retry starts, and resends the same request.
- The extension keeps retrying while the response remains HTTP 429.

## Limitation

- The extension stops retrying if the original request is aborted or if the retry attempt fails before a response is received.
