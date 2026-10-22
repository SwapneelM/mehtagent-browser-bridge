"""Real extension + native-host E2E against synthetic local pages only (macOS)."""
import argparse
import base64
import http.server
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from bridge import HOST, connect, connections, extension_id, recover
from browser import request
from install import default_host_dir, install

HTML = b'''<!doctype html><html lang="en"><meta charset="utf-8"><title>Bridge local test</title>
<style>body{font:20px system-ui;padding:40px}button,input{padding:12px;margin:10px}</style>
<h1>Local browser bridge test</h1><input id="query" value="old value"><button id="add">Add one</button>
<p id="count">0</p><input id="upload" type="file"><p id="filename"></p>
<script>document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1;
document.querySelector('#upload').onchange=e=>document.querySelector('#filename').textContent=e.target.files[0].name;</script></html>'''


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(HTML)

    def log_message(self, *args):
        pass


def run(output, executable=None):
    from playwright.sync_api import sync_playwright
    output.mkdir(parents=True, exist_ok=True)
    checks = []
    def check(condition, name):
        if not condition:
            raise AssertionError(name)
        checks.append(name)

    with tempfile.TemporaryDirectory(prefix="browser-bridge-e2e-") as td:
        temp = Path(td)
        state = temp / "state"
        ext = temp / "extension"
        shutil.copytree(ROOT / "extension", ext)
        hostname = HOST + ".test_" + uuid.uuid4().hex
        background = ext / "background.js"
        background.write_text(background.read_text().replace('const HOST = "' + HOST + '"', 'const HOST = "' + hostname + '"'))
        registry = default_host_dir()
        install(registry, state, sys.executable, temp / "runtime", host_name=hostname)
        registration = registry / (hostname + ".json")
        registrations = [registration]
        # Testing builds use their own vendor lookup directories; regular Chrome
        # and Brave share the first path. All names are unique to this test run.
        for alternate in [Path.home() / "Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts",
                          Path.home() / "Library/Application Support/Chromium/NativeMessagingHosts",
                          temp / "profile/NativeMessagingHosts"]:
            alternate.mkdir(parents=True, exist_ok=True)
            target = alternate / registration.name
            shutil.copyfile(registration, target)
            registrations.append(target)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:" + str(server.server_port) + "/"
        try:
            with sync_playwright() as pw:
                options = {"headless": True, "args": ["--disable-extensions-except=" + str(ext), "--load-extension=" + str(ext)]}
                if executable:
                    options["executable_path"] = executable
                else:
                    options["channel"] = "chromium"
                context = pw.chromium.launch_persistent_context(str(temp / "profile"), **options)
                try:
                    # Block external page requests; this run never uses user cookies or profiles.
                    context.route("**/*", lambda route: route.continue_() if route.request.url.startswith((url, "chrome-extension://")) else route.abort())
                    page = context.pages[0]
                    page.goto("chrome-extension://" + extension_id() + "/popup.html")
                    page.get_by_role("button", name="Connect", exact=True).click()
                    page.get_by_text("Connected to your assistant", exact=True).wait_for(timeout=15000)
                    check(True, "native host launched by browser and connected")
                    db = connect(state)
                    try:
                        for _ in range(50):
                            available = connections(db, True)
                            if available: break
                            time.sleep(.1)
                        check(len(available) == 1, "exactly one identified test profile")
                        cid = available[0]["id"]
                        epoch = available[0]["epoch"]
                        def call(command, agent="agent-a", **kw):
                            return request(command, state, agent=agent, connection=cid, timeout=15, **kw)
                        first = call({"action": "open", "url": url})
                        second = call({"action": "open", "url": url}, agent="agent-b")
                        check(first["id"] != second["id"] and first["target"] != second["target"], "same URL produces distinct agent-owned tabs")
                        a, b = first["target"], second["target"]
                        try:
                            call({"action": "read", "tab": a}, agent="agent-b")
                            raise AssertionError("cross-agent action was allowed")
                        except RuntimeError as error:
                            check("another agent" in str(error), "cross-agent access refused")
                        call({"action": "type", "tab": a, "selector": "#query", "text": "hello chromium"})
                        call({"action": "click", "tab": a, "selector": "#add"})
                        values = call({"action": "eval", "tab": a, "expression": "({query:document.querySelector('#query').value,count:document.querySelector('#count').textContent})"})
                        check(values == {"query": "hello chromium", "count": "1"}, "typing replaces contents and trusted click changes correct page: " + json.dumps(values))
                        untouched = call({"action": "eval", "tab": b, "expression": "document.querySelector('#count').textContent"}, agent="agent-b")
                        check(untouched == "0", "other agent tab remains unchanged")
                        upload = temp / "synthetic.txt"; upload.write_text("synthetic file")
                        call({"action": "upload", "tab": a, "selector": "#upload", "files": [str(upload)]})
                        check(call({"action": "eval", "tab": a, "expression": "document.querySelector('#filename').textContent"}) == "synthetic.txt", "file upload reaches chosen input")
                        shot = call({"action": "screenshot", "tab": a, "full_page": True})
                        (output / "local-page.png").write_bytes(base64.b64decode(shot["data"]))
                        check((output / "local-page.png").stat().st_size > 1000, "page screenshot crosses native bridge intact")
                        page.get_by_role("button", name="Disconnect", exact=True).click()
                        page.get_by_text("Disconnected", exact=True).wait_for()
                        page.get_by_role("button", name="Connect", exact=True).click()
                        page.get_by_text("Connected to your assistant", exact=True).wait_for(timeout=15000)
                        for _ in range(50):
                            current = connections(db, True)
                            if current: break
                            time.sleep(.1)
                        check(current[0]["id"] == cid and current[0]["epoch"] == epoch, "reconnect preserves browser identity and tab epoch")
                        check(call({"action": "read", "tab": a})["title"] == "Bridge local test", "agent resumes same owned target after disconnect")
                        check(recover(db, "agent-a")["targets"][0]["recoverable"], "recovery journal identifies resumable target")
                        call({"action": "close", "tab": a})
                        try:
                            call({"action": "read", "tab": a})
                            raise AssertionError("closed tab was silently replaced")
                        except RuntimeError:
                            check(True, "closed target fails without fallback")
                        check(call({"action": "read", "tab": b}, agent="agent-b")["title"] == "Bridge local test", "second agent remains usable after first tab closes")
                    finally:
                        db.close()
                except Exception:
                    diagnostic = {"page": page.locator("body").inner_text(),
                                  "native_log": (temp / "runtime/native-host.log").read_text()}
                    (output / "failure.json").write_text(json.dumps(diagnostic, indent=2))
                    page.screenshot(path=str(output / "failure.png"))
                    print(json.dumps(diagnostic, indent=2))
                    raise
                finally:
                    context.close()
        finally:
            server.shutdown()
            for registration in registrations:
                registration.unlink(missing_ok=True)
    result = {"checks": checks, "passed": len(checks), "browser": executable or "Playwright Chromium", "scope": "isolated headless profiles and synthetic localhost pages only"}
    (output / "results.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--executable")
    args = parser.parse_args()
    run(args.output.resolve(), args.executable)
