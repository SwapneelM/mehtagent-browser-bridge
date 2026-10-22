"""Render actual settings HTML/scripts with synthetic runtime replies, never user data."""
import argparse
import functools
import http.server
import json
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
RULES = {"http://127.0.0.1:4477":"allow", "http://127.0.0.1:4480":"allow", **{f"https://{n}.example.com":"ask" for n in ("one","two","three","four")}}
LEGACY = {"rules":RULES, "missing":[]}
READY = {"settingsVersion":1,"rules":RULES,"missing":[],"preferences":{"background":False,"showCursor":False},"connected":True,"policyReady":True,"policy":{"path":"/synthetic/browser-policy.json","revision":"test-1","policy":{"version":1,"sites":RULES,"preferences":{"background":False,"showCursor":False}}}}
BOOT = r"""
window.fixture = {response:RESPONSE, calls:[], grants:0, failAfterEdit:false};
window.chrome = {runtime:{getManifest:()=>({permissions:['scripting'],optional_host_permissions:['https://*/*']}),sendMessage:async(message)=>{
 fixture.calls.push(message);
 if(message.type==='rules')return fixture.response;
 if(['setRule','removeRule','preferences','replacePolicy'].includes(message.type)){
  if(message.type==='setRule')fixture.response.rules={...fixture.response.rules,[message.origin]:message.mode};
  if(message.type==='preferences')fixture.response.preferences=message.preferences;
  const result=structuredClone(fixture.response);
  if(fixture.failAfterEdit)fixture.response=undefined;
  return result;
 }
 return fixture.response;
}},permissions:{request:async()=>{fixture.grants++;return true;}}};
"""
class Handler(http.server.SimpleHTTPRequestHandler):
 def do_GET(self):
  if self.path.startswith('/favicon.ico'):
   self.send_response(204);self.end_headers();return
  return super().do_GET()
 def end_headers(self):
  self.send_header('Cache-Control','no-store');super().end_headers()
 def log_message(self,*args):pass

def run(output, expect_before=False):
 output.mkdir(parents=True,exist_ok=True)
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'extension')))
 threading.Thread(target=server.serve_forever,daemon=True).start()
 url=f'http://127.0.0.1:{server.server_port}/options.html'
 rows=[];errors=[]
 try:
  with sync_playwright() as pw:
   browser=pw.chromium.launch(headless=True)
   try:
    for width,height in [(1440,900),(390,844)]:
     page=browser.new_page(viewport={'width':width,'height':height})
     events=[]
     page.on('pageerror',lambda error:events.append(str(error)))
     page.on('console',lambda msg:events.append('console: '+msg.text) if msg.type=='error' else None)
     page.add_init_script(BOOT.replace('RESPONSE',json.dumps(LEGACY)))
     page.goto(url,wait_until='load')
     page.wait_for_function("document.querySelector('#site-count').textContent === '(6)' || document.querySelector('#error').textContent")
     if expect_before:
      screenshot=output/f'{width}-legacy-before.png';page.screenshot(path=str(screenshot),full_page=True)
      row={'viewport':width,'case':'legacy-worker','error':page.locator('#error').inner_text(),'site_rows':page.locator('.site-row').count(),'console_errors':list(events),'screenshot':screenshot.name}
      rows.append(row)
      assert 'showCursor' in row['error'],'Baseline must reproduce the actual missing-preference crash'
      assert row['site_rows']==0,'Baseline must reproduce blank saved-sites list'
      page.close();continue
     def capture(name):
      geometry=page.evaluate("""()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,rows:document.querySelectorAll('.site-row').length,error:document.querySelector('#error').textContent,saved:document.querySelector('#saved').textContent,status:document.querySelector('#connection-status').textContent,cursor:document.querySelector('#show-cursor').checked,background:document.querySelector('#background').checked,words:document.body.innerText.split(/\s+/).filter(Boolean).length,controls:[...document.querySelectorAll('#rule-form button,#import,#show-cursor,#background')].map(e=>({id:e.id||e.type,disabled:e.disabled}))})""")
      shot=output/f'{width}-{name}.png';page.screenshot(path=str(shot),full_page=True)
      row={'viewport':width,'case':name,'geometry':geometry,'console_errors':list(events),'screenshot':shot.name}
      rows.append(row)
      assert not events,(name,events)
      assert geometry['scrollWidth']<=width,(name,'page overflow',geometry)
      return geometry
     g=capture('legacy-worker')
     assert g['rows']==6 and 'Reload' in g['status'],g
     assert all(c['disabled'] for c in g['controls']),g
     # A direct legacy form submit is a fixture-only bypass to verify its guard;
     # actual user clicks target enabled controls below in the healthy case.
     awaitable="""async()=>{let value;try{await send({type:'setRule',origin:'https://ungranted.example.com',mode:'allow'});value='sent';}catch(e){value=e.message;}return {value,calls:fixture.calls,grants:fixture.grants};}"""
     attempted=page.evaluate(awaitable)
     assert attempted['value']!='sent' and not any(c.get('type')=='setRule' for c in attempted['calls']),attempted
     assert attempted['grants']==0,attempted
     # Setup-only RPC state replacement; interactions use Playwright primitives.
     page.evaluate('(next)=>{fixture.response=next;return refresh(true)}',READY)
     g=capture('healthy-false-preferences')
     assert not g['cursor'] and not g['background'] and not any(c['disabled'] for c in g['controls']),g
     page.locator('#find-site').fill('4480')
     g=capture('filter-sites');assert g['rows']==1,g
     page.locator('#find-site').fill('')
     page.locator('#show-cursor').check()
     page.wait_for_function("document.querySelector('#saved').textContent === 'Preferences saved.'")
     g=capture('save-preferences');assert g['cursor'] and not g['background'],g
     page.locator('#origin').fill('https://new.example.com')
     page.get_by_role('button',name='Add site',exact=True).click()
     page.wait_for_function("document.querySelectorAll('.site-row').length === 7")
     g=capture('add-site');assert 'Saved.' in g['saved'],g
     page.evaluate('()=>{fixture.failAfterEdit=true}')
     page.locator('#origin').fill('https://after-error.example.com')
     page.get_by_role('button',name='Add site',exact=True).click()
     page.wait_for_function("document.querySelector('#error').textContent.length > 0")
     g=capture('failed-refresh-after-save');assert not g['saved'] and all(c['disabled'] for c in g['controls']),g
     for name,case in [('disconnected',{**READY,'connected':False,'policyReady':False}),('missing-policy',{**READY,'policyReady':False,'lastError':'Shared policy file is missing; reconnect.'}),('empty-sites',{**READY,'rules':{}})]:
      page.evaluate('(next)=>{fixture.failAfterEdit=false;fixture.response=next;return refresh(true)}',case)
      g=capture(name)
      assert g['rows']==len(case['rules']),g
      if name=='disconnected':assert all(c['disabled'] for c in g['controls']),g
      if name=='missing-policy':assert all(c['disabled'] for c in g['controls'] if c['id']!='import') and not next(c['disabled'] for c in g['controls'] if c['id']=='import'),g
     page.close()
   finally:browser.close()
 finally:server.shutdown();server.server_close()
 report={'schema':'browser-settings-render/v1','source_root':str(ROOT),'synthetic_runtime':True,'user_browser_or_data_used':False,'loads':2,'baseline':expect_before,'states':rows}
 (output/'results.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({'states':len(rows),'loads':2,'baseline':expect_before,'results':str(output/'results.json')}))

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);parser.add_argument('--expect-before',action='store_true');args=parser.parse_args();run(args.output,args.expect_before)
