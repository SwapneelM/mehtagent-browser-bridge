"""Real extension + native-host E2E against synthetic local pages only (macOS)."""
import argparse
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
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from bridge import HOST, connect, connections, extension_id, recover
from browser import request
from install import default_host_dir, install

HTML = b'''<!doctype html><html lang="en"><meta charset="utf-8"><title>Bridge local test</title>
<style>body{font:20px system-ui;padding:40px}button,input{padding:12px;margin:10px}</style>
<h1>Local browser bridge test</h1><input id="query" value="old value"><button id="add">Add one</button>
<p id="count">0</p><form id="payform" action="/safe"><button id="override" formaction="/checkout">Pay<span id="nested">nested</span></button></form><button id="external" form="payform" formaction="/checkout">External submit</button><input id="upload" type="file"><p id="filename"></p>
<script>document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1;
document.querySelector('#upload').onchange=e=>document.querySelector('#filename').textContent=e.target.files[0].name;</script></html>'''


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(HTML + (b'<input autocomplete="cc-number">' if self.path == "/sensitive" else b""))

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
        # Only the copied test extension gets a required localhost grant.
        # Browser-native permission confirmation cannot be clicked headlessly.
        manifest=json.loads((ext/"manifest.json").read_text())
        manifest["host_permissions"]=["http://127.0.0.1/*"]
        (ext/"manifest.json").write_text(json.dumps(manifest))
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
                        try:
                            call({"action":"open","url":url})
                            raise AssertionError("Unlisted host was allowed")
                        except RuntimeError as error:
                            check("blocked" in str(error), "unlisted host denied before opening")
                        check(db.execute("SELECT status FROM journal ORDER BY created DESC LIMIT 1").fetchone()["status"] == "failed", "predispatch denial does not create false uncertainty")
                        with context.expect_page() as opened:
                            page.get_by_role("button",name="Site permissions",exact=True).click()
                        settings=opened.value
                        settings.wait_for_url("chrome-extension://" + extension_id() + "/options.html")
                        settings.locator("#rule-form").wait_for()
                        check(True,"Site permissions button opens the actual settings page")
                        settings.locator("#origin").fill(url.rstrip("/"))
                        settings.get_by_role("button",name="Save website").click()
                        settings.wait_for_function("()=>document.querySelector('#saved').textContent.startsWith('Saved.')",timeout=10000)
                        check(True,"settings saves exact origin with browser grant already present in synthetic test manifest")
                        settings.screenshot(path=str(output/"settings-desktop.png"))
                        settings.set_viewport_size({"width":390,"height":844})
                        settings.screenshot(path=str(output/"settings-mobile.png"),full_page=True)
                        check(settings.evaluate("document.documentElement.scrollWidth <= innerWidth"),"settings fit 390px without horizontal scroll")
                        settings.set_viewport_size({"width":1440,"height":900})
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
                        for selector in ["#override","#nested","#external"]:
                            try: call({"action":"click","tab":a,"selector":selector});raise AssertionError("Payment form clicked")
                            except RuntimeError as error: check("blocked" in str(error),"protected form variant refused: "+selector)
                            check(call({"action":"read","tab":a})["url"]==url,"form refusal preserves source URL")
                            # The rejected in-document mutation has been inspected above.
                            with db: db.execute("UPDATE journal SET status='resolved-not-run' WHERE agent='agent-a' AND status='unknown'")
                        values = call({"action":"read","tab":a})
                        check(next(e for e in values["elements"] if e["selector"]=="#query")["value"]=="hello chromium" and "1" in values["text"],"fixed typing and DOM click change correct page")
                        untouched=call({"action":"read","tab":b},agent="agent-b")
                        check("0" in untouched["text"],"other agent tab remains unchanged")
                        upload=temp/"synthetic.txt";upload.write_text("synthetic file")
                        call({"action":"upload","tab":a,"selector":"#upload","files":[str(upload)]})
                        check("synthetic.txt" in call({"action":"read","tab":a})["text"],"bounded file upload reaches chosen input")
                        for action in ["eval","cdp","key","screenshot"]:
                            try: call({"action":action,"tab":a});raise AssertionError("Unrestricted command allowed")
                            except RuntimeError as error: check("disabled" in str(error),action+" escape hatch disabled")
                        settings.locator("#mode").select_option("ask")
                        settings.get_by_role("button",name="Save website").click()
                        settings.wait_for_function("()=>document.querySelector('#saved').textContent.includes('Ask every command')")
                        with ThreadPoolExecutor() as pool:
                            pending=pool.submit(call,{"action":"read","tab":a})
                            settings.locator("#approval").wait_for(state="visible")
                            check("agent-a" in settings.locator("#approval-summary").inner_text(),"approval identifies exact agent and command")
                            settings.screenshot(path=str(output/"approval-desktop.png"))
                            page.set_viewport_size({"width":390,"height":600})
                            page.locator("#approval").wait_for(state="visible")
                            page.screenshot(path=str(output/"popup-approval.png"),full_page=True)
                            check(page.locator("#deny").bounding_box()["y"] < 550,"popup approval controls fit within 600px")
                            check(page.locator("body").evaluate("e=>getComputedStyle(e).fontSize")=="18px","popup body text increased to18px")
                            settings.get_by_role("button",name="Approve once").click()
                            check(pending.result()["title"]=="Bridge local test","single command approval executes")
                            pending=pool.submit(call,{"action":"click","tab":a,"selector":"#add"})
                            settings.locator("#approval").wait_for(state="visible")
                            settings.get_by_role("button",name="Deny",exact=True).click()
                            try: pending.result();raise AssertionError("Denied command executed")
                            except RuntimeError: check(True,"approval is not reused for subsequent command")
                        settings.locator("#mode").select_option("allow")
                        settings.get_by_role("button",name="Save website").click()
                        settings.wait_for_function("()=>document.querySelector('#saved').textContent.includes(': Allow')")
                        sensitive=call({"action":"open","url":url+"sensitive"})
                        try:call({"action":"read","tab":sensitive["target"]});raise AssertionError("Card form exposed")
                        except RuntimeError as error:check("Sensitive" in str(error),"card form content refused")
                        call({"action":"close","tab":sensitive["target"]})
                        for target_url in [url+"checkout",url.replace("127.0.0.1","localhost")]:
                            try:call({"action":"navigate","tab":a,"url":target_url});raise AssertionError("Disallowed navigation executed")
                            except RuntimeError as error:check("blocked" in str(error),"navigation destination checked: "+target_url)
                        # Reconciliation remains possible because rejected commands were never sent.
                        check(call({"action":"read","tab":a})["title"]=="Bridge local test","denied writes leave original target usable")
                        context.pages[[p.url for p in context.pages].index(url)].screenshot(path=str(output/"local-page.png"))
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
                    diagnostic = {"pages": [{"url":p.url,"text":p.locator("body").inner_text()} for p in context.pages],
                                  "native_log": (temp / "runtime/native-host.log").read_text()}
                    (output / "failure.json").write_text(json.dumps(diagnostic, indent=2))
                    page.screenshot(path=str(output / "failure.png"))
                    print(json.dumps(diagnostic, indent=2))
                    raise
                finally:
                    context.close()
                legacy=temp/"legacy-extension";shutil.copytree(ext,legacy)
                legacy_manifest=json.loads((legacy/"manifest.json").read_text())
                legacy_manifest["permissions"]=["nativeMessaging","storage","debugger","tabs"]
                legacy_manifest.pop("optional_host_permissions",None)
                legacy_manifest.pop("options_ui",None)
                (legacy/"manifest.json").write_text(json.dumps(legacy_manifest))
                old_options={**options,"args":["--disable-extensions-except="+str(legacy),"--load-extension="+str(legacy)]}
                stale=pw.chromium.launch_persistent_context(str(temp/"legacy-profile"),**old_options)
                try:
                    old_popup=stale.pages[0];old_popup.goto("chrome-extension://"+extension_id()+"/popup.html")
                    old_popup.get_by_text("Reload this extension",exact=False).wait_for()
                    check(old_popup.locator("#toggle").is_disabled(),"stale manifest refuses Connect with an explicit reload explanation")
                    with stale.expect_page() as opened:
                        old_popup.get_by_role("button",name="Site permissions",exact=True).click()
                    old_settings=opened.value;old_settings.wait_for_url("chrome-extension://"+extension_id()+"/options.html")
                    old_settings.get_by_text("Reload this extension",exact=False).wait_for()
                    check(old_settings.get_by_role("button",name="Save website").is_disabled(),"settings opens without cached options_ui and requires reload before granting sites")
                    old_settings.screenshot(path=str(output/"stale-manifest-settings.png"))
                finally:stale.close()
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
