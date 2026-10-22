# Mehtagent Browser Bridge

Let your agent work in the browser profile you already use. Open a tab, read a page, click, type, and upload a small file through a local Chromium extension. Chrome and Brave use the same extension and native host.

Each profile has a persistent connection ID. Each agent reserves its own tabs. A recovery journal survives agent exits and browser reconnects, and uncertain actions are never replayed automatically.

The native-host installer currently supports **macOS with Python 3.9+**. The extension requires Chromium 118 or newer. Browser integration was tested in isolated headless Chromium and Brave against synthetic local pages; this does not establish that every website works.

## Install

Ask your agent to read [AGENTS.md](AGENTS.md), or run:

```bash
git clone https://github.com/SwapneelM/mehtagent-browser-bridge.git
cd mehtagent-browser-bridge
python3 install.py
```

Then, in the **browser profile you want the agent to use**:

1. Open `chrome://extensions` in Chrome or `brave://extensions` in Brave.
2. Enable **Developer mode**, click **Load unpacked**, and select this repository's `extension` folder.
3. Open **Local Browser Bridge**, choose **Site permissions**, and enter an exact website origin with Allow or Ask every command. Accept the browser’s site-consent prompt. No sites are granted initially.
4. Click **Connect**. The badge shows **ON** when the native host is ready; **ASK** means a command needs your decision in the popup or Site permissions page.

The browser extension must be loaded manually. Installing the agent plugin does not grant browser access by itself. The Chrome Web Store release is pending; use this repository or the [release download](https://github.com/SwapneelM/mehtagent-browser-bridge/releases/latest).

Keep the extension folder in place. To update, pull this repository, rerun `python3 install.py`, reload the extension, and click Connect. Its ID stays the same; a second installation is unnecessary. An extension reload invalidates old tab targets, so list and reserve the intended tabs again afterward.

## Site permissions

Version 0.3 removes the broad debugger and tabs permissions. The production manifest has no required website hosts, no activeTab shortcut, and no arbitrary script/CDP escape hatch. Chromium enforces host grants for the fixed top-document script. Only the extension UI can edit site rules or approve commands; agents cannot grant sites through the native bridge.

| Setting | Behavior | Suggested hosts |
|---|---|---|
| Allow | Fixed commands run on this exact origin while connected. | `https://www.google.com`, `https://drive.google.com`, `https://docs.google.com` (Docs, Sheets, Slides). |
| Ask every command | One approval per command, agent and tab, expiring at the caller deadline. Read/claim/current also ask. | `https://mail.google.com`, `https://calendar.google.com`, `https://github.com`, `https://colab.research.google.com`. |
| Block | No bridge page access. All unlisted origins start here. | Banking, payment services, billing, login and account-security pages. |

Suggestions grant nothing. Add each origin yourself; subdomains are separate. Chromium’s host grant covers all ports on that host, while the bridge additionally enforces the exact scheme/host/port origin. HTTPS is required except for localhost testing. A wildcard grant is never requested by the UI. Setting Block revokes the optional host grant when no other allowed origin uses it.

Bank/payment hosts on the built-in list, payment/login URL paths, and detected password/card forms are additionally denied. This detection is incomplete and cannot identify every bank or payment workflow; do not grant sensitive origins. Host permission cannot distinguish searching from sharing, deleting, sending, publishing or running code. Use Ask when you want every such command reviewed, including on Workspace hosts.

The full command and destination are inspectable before approval. Upload approvals show filenames and digests; binary data is not displayed. Denied or expired approvals never grant a reusable token. Bulk tab listings hide blocked and Ask sites; focus the intended Ask tab and use `current` or request a new tab. A redirect to an Ask site requires a new approval before returning its metadata. Website-generated requests, redirects and actions retain normal website behavior: this extension is a page-access gate, not a network firewall. No top-document command can instrument a cross-origin iframe.

For approvals, keep the popup or Site permissions page open and give yourself time with `--timeout 120`. A policy edit or disconnect cancels a waiting approval. An action already submitted to the browser may still finish. The page checks its URL and command deadline again before running.

This version disables **eval, raw CDP, trusted keyboard shortcuts and screenshots**. DOM click/type events may be ignored by complex editors. File uploads are capped at 500 KB total per command. Those capability limits preserve the site boundary; Google editors and Colab still need real signed-in validation.

## Give each agent its own tabs

```bash
python3 browser.py status
python3 browser.py --connection BROWSER_ID tabs
python3 browser.py --connection BROWSER_ID current
python3 browser.py --connection BROWSER_ID --agent TASK_ID open https://www.google.com/
```

Replace `BROWSER_ID` with a `b_…` ID from status. Choose a unique, stable `TASK_ID` for this agent's task and save both IDs in your task notes. Multiple profiles are never selected by browser preference or guessed from the URL.

`open` always creates a new tab and returns its numeric browser ID plus an owned `t_…` target. To reserve an existing tab:

```bash
python3 browser.py --connection BROWSER_ID --agent TASK_ID claim 123
```

Use the returned **target ID** for page actions:

```bash
python3 browser.py --agent TASK_ID read TARGET_ID
python3 browser.py --agent TASK_ID activate TARGET_ID
python3 browser.py --agent TASK_ID navigate TARGET_ID https://www.google.com/search?q=example
python3 browser.py --agent TASK_ID type TARGET_ID '#query' 'image search'
python3 browser.py --agent TASK_ID click TARGET_ID '#submit'
python3 browser.py --agent TASK_ID scroll TARGET_ID 600
python3 browser.py --agent TASK_ID upload TARGET_ID 'input[type=file]' ./report.pdf
python3 browser.py --agent TASK_ID release TARGET_ID
```

Two tabs with identical URLs retain separate ownership targets. Missing or closed tabs produce errors instead of selecting another page. `current` uses the active tab in the focused window of the chosen profile and fails when that profile has no focused window.

Reservations last 15 minutes and are renewed by actions. An interrupted agent can resume its expired reservation if another agent has not claimed it. Another agent can claim an expired reservation, invalidating the previous target ID. Agents cannot claim a tab while its reservation is active. Different profiles have different connection IDs even if tab numbers match.

## Resume after an interruption

Use the same agent/task ID:

```bash
python3 browser.py --agent TASK_ID recover
```

Recovery lists owned targets and recent operation IDs and outcomes. A native-host reconnect preserves profile and target identity. A browser restart or extension reload changes its runtime epoch: old targets fail and must be reserved again from the current tab list.

An operation can be `completed`, `failed`, `cancelled`, or `unknown`. Unknown means the browser may have performed some or all of the action. Read the page or inspect it manually, then record what you found:

```bash
python3 browser.py --agent TASK_ID read TARGET_ID
python3 browser.py --agent TASK_ID resolve OPERATION_ID completed
# Only after checking that the action did not happen:
python3 browser.py --agent TASK_ID resolve OPERATION_ID not-run
```

Further writes to that tab are blocked while an unknown action remains unresolved. Pending commands are not dispatched behind an in-flight action. Late failures do not erase uncertain outcomes. Use `--request-id UNIQUE_ID` for retries managed by the caller. An ID already in the journal never executes twice. There is no exactly-once guarantee across a browser failure, so uncertain outcomes require inspection.

## Page controls

`read` returns page text and visible interactive elements with CSS selectors and bounded text-field values. Click and type require exactly one visible match and reject covered targets. `type` replaces contents; `--append` preserves them. Cross-site links and forms require an explicit open/navigate command so the destination can be checked. Direct protected payment/login links and forms are refused.

Text and selectors describe the top document. Embedded frames, browser internal pages, extension pages, private browsing and sensitive forms are excluded. Sign-in and consent require your manual interaction. The extension never reads cookies or browser passwords.

## Local access and storage

Connect enables fixed commands only on the sites you explicitly granted, using those pages’ signed-in accounts. **Disconnect** stops new commands; an action already dispatched may still finish. Connections do not start automatically when the browser restarts.

The browser starts Python over native messaging stdin/stdout. There is no listening HTTP port, cloud service, or webpage message endpoint. The manifest allows this extension's fixed ID. Other processes running as your OS user can access the bridge; ownership coordinates trusted agents and is not a boundary against local malware.

On macOS, runtime and persistent state live under `~/Library/Application Support/LocalBrowserBridge/`. The SQLite journal records only operation metadata, ownership, and outcomes. Temporary payloads are removed after completion, timeout, or expiry. Site rules persist in extension-local storage; pending approvals do not persist or replay. Your agent's own tool logs are outside the extension's control.

Chrome and Brave both look for the native-host manifest under `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`. Runtime files live outside Documents because macOS can deny browser-launched helpers access there. Startup errors go to `~/Library/Application Support/LocalBrowserBridge/native-host.log`. A sandboxed assistant needs filesystem access to the state directory; the local bridge itself needs no network connection.

## Agent plugins

The repository includes a Claude-compatible plugin in `.claude-plugin/` with a browser skill and command. Other agents can read [AGENTS.md](AGENTS.md) and use the same CLI. Mehtagent's required-plugin registration links users to these manual installation steps. Browser access remains disconnected until the user loads the extension and clicks Connect.

## Checks

```bash
python3 -m unittest discover -s tests -v
node --test tests/background.test.cjs
python3 -m pip install playwright==1.58.0
python3 -m playwright install chromium
python3 tests/e2e.py --output /tmp/browser-bridge-evidence
```

The last command runs the actual extension and native host in isolated headless profiles against synthetic localhost pages. Each test registers a host with a random name and removes that registration afterward. It does not use your browser profile or accounts. The checks and their limits are documented in [TESTING.md](TESTING.md).

## Remove

Disconnect, remove **Local Browser Bridge** from each browser, and remove `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.mehtagent.browser_bridge.json`. You can then remove this checkout and `~/Library/Application Support/LocalBrowserBridge/`, including its recovery journal.
