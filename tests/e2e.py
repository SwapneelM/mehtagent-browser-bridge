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
from policy_store import snapshot as policy_snapshot, update as update_policy

HTML = b'''<!doctype html><html lang="en"><meta charset="utf-8"><title>Bridge local test</title>
<style>body{font:20px system-ui;padding:40px}button,input{padding:12px;margin:10px}</style>
<div id="longdoc"></div><div id="shadow-host"></div><div id="scrollbox" style="height:90px;width:250px;overflow:auto"><div style="height:1200px">Scrollable content</div></div><iframe id="sameframe" src="/frame" title="Same-origin test frame"></iframe><button role="menuitem" aria-label="Semantic action" id="semantic">More</button><p id="events"></p><div id="editable" contenteditable="true">Old editable</div><h1>Local browser bridge test</h1><input id="query" value="old value"><button id="add">Add one</button>
<p id="count">0</p><form id="payform" action="/safe"><button id="override" formaction="/checkout">Pay<span id="nested">nested</span></button></form><button id="external" form="payform" formaction="/checkout">External submit</button><input id="upload" type="file"><p id="filename"></p>
<script>
if(location.pathname==='/frame')document.body.innerHTML='<button id="framebutton">Frame button</button>';
else {
document.querySelector('#longdoc').textContent='Long document '+ 'x'.repeat(25000)+' END_MARKER';
const shadow=document.querySelector('#shadow-host').attachShadow({mode:'open'});shadow.innerHTML='<button id="shadow-button" aria-label="Shadow action">Shadow button</button><p id="shadow-count">0</p>';shadow.querySelector('button').onclick=()=>shadow.querySelector('p').textContent='Shadow clicked';
const types=[];for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])document.querySelector('#semantic').addEventListener(type,()=>{types.push(type);document.querySelector('#events').textContent=types.join(',');});
document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1;
document.querySelector('#upload').onchange=e=>document.querySelector('#filename').textContent=e.target.files[0].name;}</script></html>'''


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/vendor/'):
            relative = self.path.removeprefix('/vendor/').split('?')[0]
            base = (ROOT / 'node_modules/monaco-editor/min').resolve()
            asset = (base / relative).resolve()
            if not asset.is_relative_to(base) or not asset.is_file():
                self.send_error(404); return
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript' if asset.suffix=='.js' else 'text/css' if asset.suffix=='.css' else 'application/octet-stream')
            self.end_headers(); self.wfile.write(asset.read_bytes()); return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        if self.path == '/frame':
            self.wfile.write(b'''<html><body><button id="framebutton" onclick="this.textContent='Frame clicked'">Frame button</button></body></html>'''); return
        if self.path == '/editor':
            self.wfile.write(b'''<!doctype html><html><body><div id="editor" style="width:700px;height:400px"></div><script src="/vendor/vs/loader.js"></script><script>require.config({paths:{vs:'/vendor/vs'}});require(['vs/editor/editor.main'],()=>{window.editor=monaco.editor.create(document.querySelector('#editor'),{value:'original editor text',language:'python',automaticLayout:true});});</script></body></html>'''); return
        self.wfile.write(HTML + (b'<input autocomplete="cc-number">' if self.path == "/sensitive" else b""))

    def log_message(self, *args):
        pass


def run(output, executable=None):
    from playwright.sync_api import sync_playwright
    output.mkdir(parents=True, exist_ok=True)
    checks = []
    measurements = []
    (output / "results.json").unlink(missing_ok=True)
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
        manifest["host_permissions"]=["http://127.0.0.1/*","https://www.google.com/*"]
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
                        settings.wait_for_function("()=>!document.querySelector('#rule-form button').disabled")
                        settings.locator("#origin").fill(url.rstrip("/"))
                        settings.get_by_role("button",name="Add site").click()
                        settings.wait_for_function("()=>document.querySelector('#saved').textContent.startsWith('Saved.')",timeout=10000)
                        check(True,"settings saves exact origin with browser grant already present in synthetic test manifest")
                        policy_file=temp/'browser-policy.json'
                        check(policy_snapshot(policy_file)['policy']['sites'][url.rstrip('/')]=='allow',"site UI writes the shared local policy file")
                        settings.get_by_role('button',name='Google Search +',exact=True).click()
                        settings.wait_for_function("()=>document.querySelector('#saved').textContent.startsWith('Added https://www.google.com')")
                        check(policy_snapshot(policy_file)['policy']['sites']['https://www.google.com']=='allow',"common-site button adds its exact origin with pregranted synthetic browser consent")
                        settings.get_by_role('button',name='Remove https://www.google.com',exact=True).click()
                        settings.wait_for_function("()=>!document.querySelector('[data-origin=\"https://www.google.com\"].site-row')")
                        check('https://www.google.com' not in policy_snapshot(policy_file)['policy']['sites'],"Remove deletes shared policy rule")
                        settings.get_by_role('button',name='Undo',exact=True).click()
                        settings.wait_for_function("()=>!!document.querySelector('[data-origin=\"https://www.google.com\"].site-row')")
                        check('https://www.google.com' in policy_snapshot(policy_file)['policy']['sites'],"Undo restores exact removed access")
                        settings.get_by_role('button',name='Remove https://www.google.com',exact=True).click()
                        settings.wait_for_function("()=>!document.querySelector('[data-origin=\"https://www.google.com\"].site-row')")
                        settings.locator('#show-cursor').uncheck()
                        settings.wait_for_function("()=>document.querySelector('#saved').textContent==='Preferences saved.'")
                        check(policy_snapshot(policy_file)['policy']['preferences']['showCursor'] is False,"cursor preference saved in shared file")
                        value=policy_snapshot(policy_file)
                        update_policy(policy_file,value['revision'],{'preferences':{'showCursor':True}})
                        settings.wait_for_function("()=>document.querySelector('#show-cursor').checked")
                        check(True,"external policy edits sync into connected browser")
                        preserved=policy_file.read_bytes()
                        policy_file.write_text('{"private-marker":')
                        settings.wait_for_function("()=>document.querySelector('#rule-form button').disabled")
                        try:call({'action':'open','url':url});raise AssertionError('Malformed policy allowed action')
                        except RuntimeError as error:check('policy' in str(error).lower(),'invalid shared file blocks actions instead of using stale cached grants')
                        policy_file.write_bytes(preserved)
                        settings.wait_for_function("()=>!document.querySelector('#rule-form button').disabled")
                        check(True,'restoring valid policy recovers connected browser without a reload')


                        settings.set_viewport_size({"width":390,"height":844})
                        check(settings.evaluate("document.documentElement.scrollWidth <= innerWidth"),"settings fit 390px without horizontal scroll")
                        settings.set_viewport_size({"width":1440,"height":900})
                        baseline=policy_snapshot(policy_file)
                        for count in (0,4,200):
                            sites={f'https://site{i}.example':'ask' for i in range(count)}
                            value=policy_snapshot(policy_file)
                            update_policy(policy_file,value['revision'],{'replace':{'version':1,'sites':sites}})
                            settings.wait_for_function("n=>document.querySelector('#site-count').textContent==='('+n+')'",arg=count)
                            if count==4:check(settings.locator('.needs-consent').count()==4,'file-imported sites show missing browser consent and Grant access controls')
                            for width,height in ((1440,900),(390,844)):
                                settings.set_viewport_size({'width':width,'height':height})
                                metric=settings.evaluate("""()=>({horizontal:document.documentElement.scrollWidth>innerWidth,policyLink:document.querySelector('#policy-link').getBoundingClientRect().bottom,policyHeading:document.querySelector('#policy-heading').getBoundingClientRect().top,bodyHeight:document.documentElement.scrollHeight,list:document.querySelector('#rules').getBoundingClientRect().height,words:document.body.innerText.trim().split(/\\s+/).length,bodyFont:getComputedStyle(document.body).fontSize})""")
                                measurements.append({"sites":count,"width":width,**metric})
                                if count==4 and width==390:
                                    settings.locator('#policy-link').click()
                                    settings.wait_for_function("()=>document.activeElement.id==='policy-heading'")
                                    check(settings.locator('#policy-heading').bounding_box()['y']<height,'mobile Policy file link focuses reachable policy panel')
                                    settings.evaluate('window.scrollTo(0,0)')

                                check(not metric['horizontal'] and metric['policyLink']<height and metric['bodyFont']=='18px',f'{count} sites at {width}px: no horizontal scroll, policy route visible, 18px text')
                                if width==1440:check(metric['policyHeading']<height and metric['bodyHeight']<=height,f'{count} sites: desktop tasks fit without body scrolling')
                        value=policy_snapshot(policy_file)
                        update_policy(policy_file,value['revision'],{'replace':baseline['policy']})
                        settings.wait_for_function("()=>document.querySelector('#site-count').textContent==='(1)'")
                        settings.set_viewport_size({'width':1440,'height':900})
                        check(settings.locator('.needs-consent').count()==0,'restored localhost policy retains its browser consent')
                        # Import previews replace changes; acceptance stays tied
                        # to a fresh Apply click rather than file selection.
                        import_file=temp/'import-policy.json'
                        import_file.write_text(json.dumps(baseline['policy']))
                        settings.locator('#policy-file').set_input_files(str(import_file))
                        settings.locator('#import-preview').wait_for(state='visible')
                        check('0 added' in settings.locator('#import-counts').inner_text(),'import shows explicit change preview before applying')
                        settings.get_by_role('button',name='Apply policy',exact=True).click()
                        settings.locator('#import-preview').wait_for(state='hidden')
                        check(policy_snapshot(policy_file)['policy']==baseline['policy'],'policy import round trips canonical rules and preferences')
                        with settings.expect_download() as download:
                            settings.get_by_role('button',name='Export',exact=True).click()
                        export_file=temp/'exported.json';download.value.save_as(str(export_file))
                        check(json.loads(export_file.read_text())==baseline['policy'],'export includes policy only, without session or page data')

                        worker=context.service_workers[0]
                        focused_before=worker.evaluate("async()=>({tabs:(await chrome.tabs.query({active:true})).map(t=>t.id),windows:(await chrome.windows.getAll()).filter(w=>w.focused).map(w=>w.id)})")
                        with context.expect_page() as opening_a:
                            first = call({"action": "open", "url": url})
                        first_page=opening_a.value
                        first_page.wait_for_url(url)
                        with context.expect_page() as opening_b:
                            second = call({"action": "open", "url": url}, agent="agent-b")
                        check(first["id"] != second["id"] and first["target"] != second["target"], "same URL produces distinct agent-owned tabs")
                        a, b = first["target"], second["target"]
                        focused_after=worker.evaluate("async()=>({tabs:(await chrome.tabs.query({active:true})).map(t=>t.id),windows:(await chrome.windows.getAll()).filter(w=>w.focused).map(w=>w.id)})")
                        check(focused_before==focused_after,"background tab creation preserves active tabs and focused window")
                        page_text=call({"action":"read","tab":a})
                        check(page_text['nextOffset']==20000 and page_text['totalText']>25000,"long document exposes text pagination")
                        check('END_MARKER' in call({"action":"read","tab":a,"offset":20000})['text'],"later text is accessible without screenshots")
                        scoped=call({"action":"read","tab":a,"selector":"#query","html":True})
                        check(scoped['text']=='old value' and '<input' in scoped['html'],"scoped read includes input value and sanitized HTML")
                        call({"action":"click","tab":a,"role":"menuitem","name":"Semantic action"})
                        check(call({"action":"read","tab":a,"selector":"#events"})['text']=='pointerdown,mousedown,pointerup,mouseup,click',"ARIA name click dispatches pointer and mouse event sequence")
                        check(first_page.locator('#__mehtagent_cursor__').evaluate("e=>getComputedStyle(e).pointerEvents")=='none',"agent cursor cannot intercept page input")
                        check(first_page.locator('#__mehtagent_cursor__').evaluate("e=>e.dataset.agent==='agent-a' && e.dataset.action==='click' && Number(e.dataset.x)>=0 && Number(e.dataset.y)>=0 && Number(e.dataset.x)<innerWidth && Number(e.dataset.y)<innerHeight"),"virtual cursor identifies agent and action within viewport")

                        value=policy_snapshot(policy_file);update_policy(policy_file,value['revision'],{'preferences':{'showCursor':False}})
                        settings.wait_for_function("()=>!document.querySelector('#show-cursor').checked")
                        call({'action':'click','tab':a,'selector':'#semantic'})
                        check(first_page.locator('#__mehtagent_cursor__').count()==0,'cursor preference disables and removes page indicator')
                        value=policy_snapshot(policy_file);update_policy(policy_file,value['revision'],{'preferences':{'showCursor':True}})
                        settings.wait_for_function("()=>document.querySelector('#show-cursor').checked")
                        call({"action":"click","tab":a,"selector":"#shadow-host >>> #shadow-button"})
                        check('Shadow clicked' in call({"action":"read","tab":a,"selector":"#shadow-host"})['text'],"open shadow DOM selectors click and read exact controls")
                        call({"action":"click","tab":a,"selector":"#sameframe >>> #framebutton"})
                        check('Frame clicked' in call({"action":"read","tab":a,"selector":"#sameframe >>> body"})['text'],"same-origin frame commands preserve site boundary")
                        call({"action":"scroll","tab":a,"selector":"#scrollbox","y":500})
                        check(first_page.locator('#scrollbox').evaluate('e=>e.scrollTop')==500,"explicit scroll target reaches nested container")
                        call({"action":"type","tab":a,"selector":"#editable","text":"Replaced editable"})
                        check(call({"action":"read","tab":a,"selector":"#editable"})['text']=='Replaced editable',"contenteditable replaces only chosen editable range")

                        try:
                            call({"action": "read", "tab": a}, agent="agent-b")
                            raise AssertionError("cross-agent action was allowed")
                        except RuntimeError as error:
                            check("another agent" in str(error), "cross-agent access refused")
                        with context.expect_page() as opening_editor:
                            editor_tab=call({'action':'open','url':url+'editor'})
                        editor_page=opening_editor.value
                        editor_page.wait_for_url(url+'editor')
                        editor_page.wait_for_function('!!window.editor')
                        outcome=call({'action':'type','tab':editor_tab['target'],'selector':'#editor','text':'replacement editor text\nsecond line'})
                        check(outcome.get('adapter')=='monaco-textarea' and editor_page.evaluate('editor.getValue()')=='replacement editor text\nsecond line',"Monaco DOM adapter replaces actual editor model without debugger")
                        call({'action':'type','tab':editor_tab['target'],'selector':'#editor','text':'\nappended line','append':True})
                        check(editor_page.evaluate('editor.getValue()')=='replacement editor text\nsecond line\nappended line',"Monaco append preserves complete previous model")
                        call({'action':'close','tab':editor_tab['target']})
                        call({"action": "type", "tab": a, "selector": "#query", "text": "hello chromium"})
                        call({"action": "click", "tab": a, "selector": "#add"})
                        for selector in ["#override","#nested","#external"]:
                            try: call({"action":"click","tab":a,"selector":selector});raise AssertionError("Payment form clicked")
                            except RuntimeError as error: check("blocked" in str(error),"protected form variant refused: "+selector)
                            check(call({"action":"read","tab":a})["url"]==url,"form refusal preserves source URL")
                            # The rejected in-document mutation has been inspected above.
                            with db: db.execute("UPDATE journal SET status='resolved-not-run' WHERE agent='agent-a' AND status='unknown'")
                        values = call({"action":"read","tab":a,"selector":"body","offset":25000})
                        check(next(e for e in values["elements"] if e["selector"]=="#query")["value"]=="hello chromium" and "1" in values["text"],"fixed typing and DOM click change correct page")
                        untouched=call({"action":"read","tab":b,"offset":25000},agent="agent-b")
                        check("0" in untouched["text"],"other agent tab remains unchanged")
                        upload=temp/"synthetic.txt";upload.write_text("synthetic file")
                        call({"action":"upload","tab":a,"selector":"#upload","files":[str(upload)]})
                        check("synthetic.txt" in call({"action":"read","tab":a,"offset":25000})["text"],"bounded file upload reaches chosen input")
                        for action in ["eval","cdp","key","screenshot"]:
                            try: call({"action":action,"tab":a});raise AssertionError("Unrestricted command allowed")
                            except RuntimeError as error: check("disabled" in str(error),action+" escape hatch disabled")
                        settings.locator("#mode").select_option("ask")
                        settings.get_by_role("button",name="Add site").click()
                        settings.wait_for_function("()=>document.querySelector('#saved').textContent.includes('Ask every command')")
                        with ThreadPoolExecutor() as pool:
                            pending=pool.submit(call,{"action":"read","tab":a})
                            settings.locator("#approval").wait_for(state="visible")
                            check("agent-a" in settings.locator("#approval-summary").inner_text(),"approval identifies exact agent and command")
                            page.set_viewport_size({"width":390,"height":600})
                            page.locator("#approval").wait_for(state="visible")
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
                        settings.get_by_role("button",name="Add site").click()
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
                    diagnostic = {"measurements":measurements,"pages": [{"url":p.url,"text":p.locator("body").inner_text()[:1800]} for p in context.pages],
                                  "native_log": (temp / "runtime/native-host.log").read_text()}
                    (output / "failure.json").write_text(json.dumps(diagnostic, indent=2))
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
                    check(old_settings.get_by_role("button",name="Add site").is_disabled(),"settings opens without cached options_ui and requires reload before granting sites")
                finally:stale.close()
        finally:
            server.shutdown()
            for registration in registrations:
                registration.unlink(missing_ok=True)
    result = {"measurements":measurements,"checks": checks, "passed": len(checks), "browser": executable or "Playwright Chromium", "scope": "isolated headless profiles and synthetic localhost pages only"}
    (output / "results.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--executable")
    args = parser.parse_args()
    run(args.output.resolve(), args.executable)
