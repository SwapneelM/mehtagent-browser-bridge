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
3. Open **Local Browser Bridge** and click **Connect**. No sites are granted initially.
4. Choose **Site permissions**, click a common-site suggestion or paste a website URL, and choose Allow or Ask every command. Accept the browser’s site-consent prompt. The badge shows **ON** when the native host is ready; **ASK** means a command needs your decision in the popup or Site permissions page.

The browser extension must be loaded manually. Installing the agent plugin does not grant browser access by itself. The Chrome Web Store release is pending; use this repository or the [release download](https://github.com/SwapneelM/mehtagent-browser-bridge/releases/latest).

Keep the extension folder in place. To update, pull this repository, rerun `python3 install.py`, reload the extension, and click Connect. Its ID stays the same; a second installation is unnecessary. An extension reload invalidates old tab targets, so list and reserve the intended tabs again afterward.

## Site permissions

Version 0.3 removes the broad debugger and tabs permissions. The production manifest has no required website hosts, no activeTab shortcut, and no arbitrary script/CDP escape hatch. Chromium enforces host grants for the fixed top-document script. The extension UI saves site rules into a shared local policy file. Only a browser user gesture can grant new host consent or approve a command; agent page commands cannot grant sites.

| Setting | Behavior | Suggested hosts |
|---|---|---|
| Allow | Fixed commands run on this exact origin while connected. | `https://www.google.com`, `https://drive.google.com`, `https://docs.google.com` (Docs, Sheets, Slides). |
| Ask every command | One approval per command, agent and tab, expiring at the caller deadline. Read/claim/current also ask. | `https://mail.google.com`, `https://calendar.google.com`, `https://github.com`, `https://colab.research.google.com`. |
| Block | No bridge page access. All unlisted origins start here. | Banking, payment services, billing, login and account-security pages. |

Common-site buttons add one exact origin after your browser consent. Colab, Gmail, Calendar and GitHub suggestions use Ask; existing choices are preserved. Saved rows have access controls, Remove and Undo. Subdomains are separate. Chromium’s host grant covers all ports on that host, while the bridge additionally enforces the exact scheme/host/port origin. HTTPS is required except for localhost testing. A wildcard grant is never requested by the UI. Setting Block revokes the optional host grant when no other allowed origin uses it.

Bank/payment hosts on the built-in list, payment/login URL paths, and detected password/card forms are additionally denied. This detection is incomplete and cannot identify every bank or payment workflow; do not grant sensitive origins. Host permission cannot distinguish searching from sharing, deleting, sending, publishing or running code. Use Ask when you want every such command reviewed, including on Workspace hosts.

The full command and destination are inspectable before approval. Upload approvals show filenames and digests; binary data is not displayed. Denied or expired approvals never grant a reusable token. Bulk tab listings hide blocked and Ask sites; focus the intended Ask tab and use `current` or request a new tab. A redirect to an Ask site requires a new approval before returning its metadata. Website-generated requests, redirects and actions retain normal website behavior: this extension is a page-access gate, not a network firewall. No top-document command can instrument a cross-origin iframe.

For approvals, keep the popup or Site permissions page open and give yourself time with `--timeout 120`. A policy edit or disconnect cancels a waiting approval. An action already submitted to the browser may still finish. The page checks its URL and command deadline again before running.

This version disables **eval, raw CDP, trusted keyboard shortcuts and screenshots**. Fixed DOM commands provide ARIA name/role targeting, pointer events and bounded text/HTML reads. Contenteditable uses scoped DOM text and InputEvents. The Monaco textarea adapter uses range replacement and InputEvents, tested against a pinned local editor fixture; this does not establish compatibility with every Google editor or Colab version. File uploads are capped at 500 KB total per command.

## Give each agent its own tabs

```bash
python3 browser.py status
python3 browser.py --connection BROWSER_ID tabs
python3 browser.py --connection BROWSER_ID current
python3 browser.py --connection BROWSER_ID --agent TASK_ID open https://www.google.com/
```

Replace `BROWSER_ID` with a `b_…` ID from status. Choose a unique, stable `TASK_ID` for this agent's task and save both IDs in your task notes. Multiple profiles are never selected by browser preference or guessed from the URL.

`open` creates a background tab by default, leaving your active tab and focused window alone. Use `open URL --foreground`, `activate TARGET`, or disable the background preference only when you want focus to move. Page actions do not focus the browser. `open` always creates a new tab and returns its numeric browser ID plus an owned `t_…` target. To reserve an existing tab:

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

Reads include open shadow roots and same-origin frames, with selectors such as `#host >>> button` or `#frame >>> #field`. Cross-origin frames, closed shadow roots, browser internal pages, extension pages, private browsing and sensitive forms are excluded. Sign-in and consent require your manual interaction. The extension never reads cookies or browser passwords.

```bash
python3 browser.py --agent TASK_ID read TARGET_ID --selector main --offset 20000 --limit 20000
python3 browser.py --agent TASK_ID read TARGET_ID --html --element-offset 180
python3 browser.py --agent TASK_ID click TARGET_ID --role button --name "Save"
python3 browser.py --agent TASK_ID scroll TARGET_ID 500 --selector '#results'
python3 browser.py --agent TASK_ID type TARGET_ID '#editor' 'replacement code'
```

Read results report `nextOffset` and `nextElementOffset`; use those to continue instead of guessing or taking screenshots. Text is capped at 500,000 characters per scope; individual responses are bounded. `--html` returns up to 20,000 characters of sanitized markup, with scripts, frames and inline event handlers removed. DOM names are derived from ARIA labels, associated labels and visible text; they are not a complete accessibility-tree implementation. Click events remain untrusted DOM input.

The optional **Show agent cursor** preference displays a short agent/action label beside a page target. It never moves the OS pointer, changes window focus, shows typed content, or delays the command. The label fades after about two seconds; background-page timers may clean it up later. You see it when viewing the target tab.

## Shared local policy

Every agent and connected profile can use one versioned JSON file. The default is `~/.config/mehtagent/browser-policy.json` (or `$XDG_CONFIG_HOME/mehtagent/browser-policy.json`). Override with `MEHTAGENT_BROWSER_POLICY` before installation, or `python3 install.py --policy-file /path/to/browser-policy.json`. Use that same path for CLI inspection. The extension uses the path embedded in its installed native launcher.

```json
{"version":1,"sites":{"https://drive.google.com":"allow","https://colab.research.google.com":"ask"},"preferences":{"background":true,"showCursor":true}}
```

See [the schema](browser-policy.schema.json) and [optional starter example](browser-policy.example.json). The example is never installed automatically. On first connection, existing extension rules are migrated once if the file is missing; an existing shared file wins. This preserves an existing Allow choice for Colab rather than resetting it to the suggested Ask mode.

Site permissions shows the file location and supports Import with a change preview and Export. A connected host is required to save edits. Changes use atomic owner-only writes and revision checks, so one profile cannot silently overwrite another profile's intervening edit. Connected hosts watch external file changes. Files are limited to 64 KB and 200 exact origins. Unknown fields, malformed JSON, duplicate keys on disk, protected host grants and invalid preferences fail closed. Restore an invalid/missing file and reconnect. Already-dispatched actions may still finish.

```bash
python3 browser.py policy show
python3 browser.py policy validate ./browser-policy.json
python3 browser.py policy example
```

**The policy file does not grant browser consent.** A new origin added on disk remains inaccessible in each browser until its user clicks **Grant access** and accepts the native browser prompt. Removing or blocking a rule revokes its unused optional host grant. Treat policy edits as trusted user configuration; the bridge coordinates agents running as your OS user, rather than isolating those processes from the file.

## Local access and storage

Connect enables fixed commands only on the sites you explicitly granted, using those pages’ signed-in accounts. **Disconnect** stops new commands; an action already dispatched may still finish. Connections do not start automatically when the browser restarts.

The browser starts Python over native messaging stdin/stdout. There is no listening HTTP port, cloud service, or webpage message endpoint. The manifest allows this extension's fixed ID. Other processes running as your OS user can access the bridge; ownership coordinates trusted agents and is not a boundary against local malware.

On macOS, runtime and persistent state live under `~/Library/Application Support/LocalBrowserBridge/`. The SQLite journal records operation metadata, ownership, outcomes and fixed failure codes; raw error text is excluded. Agent IDs and labels persist, so choose non-sensitive names. IPC commands/results temporarily include URLs, page text, typed text and upload bytes in an owner-protected local database; they are deleted on completion/timeout or on the next bridge access after expiry. SQLite secure_delete is enabled, and legacy journal error text is redacted on access. This is not a promise of forensic erasure from OS backups or snapshots. Site rules and preferences persist in the shared local JSON file and a cached copy in extension-local storage; the file contains no task/session/page data. Pending approvals do not persist or replay. Your agent's own tool logs are outside the extension's control.

Chrome and Brave both look for the native-host manifest under `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`. Runtime files live outside Documents because macOS can deny browser-launched helpers access there. Startup errors go to `~/Library/Application Support/LocalBrowserBridge/native-host.log`. A sandboxed assistant needs filesystem access to the state directory; the local bridge itself needs no network connection.

## Agent plugins

The repository includes a Claude-compatible plugin in `.claude-plugin/` with a browser skill and command. Other agents can read [AGENTS.md](AGENTS.md) and use the same CLI. Mehtagent's required-plugin registration links users to these manual installation steps. Browser access remains disconnected until the user loads the extension and clicks Connect.

## Checks

```bash
python3 -m unittest discover -s tests -v
node --test tests/*.test.cjs
python3 -m pip install playwright==1.58.0
python3 -m playwright install chromium
npm ci --ignore-scripts --no-audit --no-fund
python3 tests/e2e.py --output /tmp/browser-bridge-evidence
```

The last command runs the actual extension and native host in isolated headless profiles against synthetic localhost pages. Each test registers a host with a random name and removes that registration afterward. It does not use your browser profile or accounts. The checks and their limits are documented in [TESTING.md](TESTING.md).

## Remove

Disconnect, remove **Local Browser Bridge** from each browser, and remove `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.mehtagent.browser_bridge.json`. You can then remove this checkout and `~/Library/Application Support/LocalBrowserBridge/`, including its recovery journal. Remove the shared policy separately if you no longer need it.

## Portability and privacy boundary

The extension uses Chromium APIs and has no browser-brand or personal-path assumptions. Its supported native installer is currently **macOS only**; Linux and Windows installers are not implemented or validated. User/runtime paths are resolved on the installing machine, rather than copied from a developer’s checkout. Do not advertise full cross-platform support.

There is no telemetry or remote logging service in the bridge. Native startup logs contain exception type codes, not raw request bodies or exception messages. Live CLI/tool responses necessarily contain requested page data. Your agent provider, shell history, conversation logs, browser profiles and OS backups are separate systems; this extension cannot guarantee they retain no sensitive information. Treat the state directory as sensitive while commands run.

If updated popup files load with an older cached manifest, Connect/site-grant actions show a Reload explanation. Site permissions opens an extension tab directly, so it does not depend on cached options_ui. A failed button action stays visible instead of being erased by status polling.

## Updating the Site access page

After updating an unpacked extension, open your browser’s Extensions page and press **Reload** on Local Browser Bridge, then **Connect**. Do this once in each browser profile you use. Your saved site choices are preserved.

Version0.4.1 keeps the saved-site list readable when a new settings page encounters an older running worker. Changes stay disabled until the versions match. A failed save returns controls to the last confirmed values and shows an error instead of a success message.

Example: to let an agent test Mehtagent Lite, add `http://127.0.0.1:4480` under Site access and choose Allow. Enterprise uses `http://127.0.0.1:4477`. Each exact origin has its own choice. The agent cannot grant these permissions for you.

If an established shared policy file is deleted or malformed, restore a valid copy at the displayed path and reconnect. Import does not currently repair those cases; the bridge keeps access closed and preserves existing data.
