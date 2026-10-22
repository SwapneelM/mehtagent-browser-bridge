const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const policy = require('../extension/policy.js');

function event() {
  const listeners = [];
  return { addListener: f => listeners.push(f), emit: (...args) => listeners.forEach(f => f(...args)) };
}

function setup() {
  const calls = [];
  const replies = [];
  const port = { onMessage: event(), onDisconnect: event(), postMessage: m => replies.push(m), disconnect() {} };
  const tabs = new Map([[11, { id: 11, windowId: 1, title: 'A', url: 'https://example.com/', active: true, status: 'complete' }],
                        [12, { id: 12, windowId: 1, title: 'B', url: 'https://example.com/', active: false, status: 'complete' }]]);
  let focused = true;
  let granted = true;
  let rules = {"https://example.com":"allow","https://example.org":"allow"};
  const chrome = {
    runtime: { id: 'test', getURL:p=>'chrome-extension://test/'+p, connectNative: () => port, onMessage: event(), getPlatformInfo: async () => ({ os: 'mac' }) },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    storage: {local:{get:async()=>({siteRules: rules}),set:async data=>{if(data.siteRules) rules=data.siteRules;},setAccessLevel:async()=>{} }},
    permissions: {contains:async()=>granted,remove:async()=>true},
    scripting: {executeScript:async options=>{calls.push(['script',options]);return [{result:{ok:true,result:'page A'}}];}},
    tabs: { onRemoved: event(), query: async () => [...tabs.values()],
      get: async id => { if (!tabs.has(id)) throw new Error('No tab with id: ' + id); return { ...tabs.get(id) }; },
      create: async options => {
        calls.push(['create', options]);
        const tab = { id: 99, windowId: 1, status: 'complete', ...options };
        tabs.set(99, tab); return tab;
      },
      update: async (id, options) => { calls.push(['update', id, options]); Object.assign(tabs.get(id), options); return { ...tabs.get(id) }; },
      remove: async id => { calls.push(['remove', id]); tabs.delete(id); } },
    windows: { update: async (...args) => { calls.push(['window', ...args]); },
      getAll: async () => [{ id: 1, focused, tabs: [...tabs.values()] }] },
  };
  const ctx = vm.createContext({ chrome, console, URL, setTimeout, clearTimeout, Date, crypto, SitePolicy:policy, importScripts(){} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), ctx);
  vm.runInContext('connect()', ctx);
  port.onMessage.emit({ type: 'ready', session: 's1', connection: 'b_1', epoch: 'e_1' });
  async function command(payload, expires = Date.now() / 1000 + 10) {
    const id = String(replies.length);
    port.onMessage.emit({ type: 'command', id, expires, command: payload });
    await vm.runInContext('queue', ctx);
    return replies.length ? JSON.parse(JSON.stringify(replies.at(-1))) : null;
  }
  return { calls, tabs, chrome, ctx, port, command, unfocus: () => { focused = false; }, setRules: r=>{rules=r;}, revoke:()=>{granted=false;} };
}

test('new tab means a new ID even when another tab has the same URL', async () => {
  const s = setup();
  const reply = await s.command({ action: 'open', url: 'https://example.com/' });
  assert.equal(reply.result.id, 99);
  assert.equal(s.calls.filter(c => c[0] === 'create').length, 1);
  assert.equal(s.calls.find(c => c[0] === 'create')[1].active, true);
});

test('actions use the exact tab ID, not a matching URL', async () => {
  const s = setup();
  assert.equal((await s.command({ action: 'read', tab: 12 })).ok, true);
  assert.equal(s.calls.find(c => c[0] === 'script')[1].target.tabId, 12);
  assert.equal((await s.command({ action: 'read', tab: 404 })).ok, false);
  assert.equal(s.calls.filter(c => c[0] === 'script').length, 1);
});

test('current uses the active tab of a focused window and never guesses', async () => {
  const s = setup();
  assert.equal((await s.command({ action: 'current' })).result.id, 11);
  s.unfocus();
  assert.match((await s.command({ action: 'current' })).error, /No focused window/);
});

test('navigate and close stay scoped to the selected tab', async () => {
  const s = setup();
  await s.command({ action: 'navigate', tab: 12, url: 'https://example.org/' });
  assert.equal(s.tabs.get(11).url, 'https://example.com/');
  assert.equal(s.tabs.get(12).url, 'https://example.org/');
  await s.command({ action: 'close', tab: 12 });
  assert.ok(s.tabs.has(11));
  assert.ok(!s.tabs.has(12));
});

test('expired commands do not create a tab', async () => {
  const s = setup();
  const reply = await s.command({ action: 'open', url: 'https://example.com/' }, Date.now() / 1000 - 1);
  assert.match(reply.error, /expired/);
  assert.equal(s.calls.length, 0);
});

test('browser pages, private tabs and non-web URLs are rejected', async () => {
  const s = setup();
  assert.equal((await s.command({ action: 'open', url: 'javascript:alert(1)' })).ok, false);
  s.tabs.get(11).url = 'brave://settings/';
  assert.equal((await s.command({ action: 'read', tab: 11 })).ok, false);
  s.tabs.get(11).url = 'chrome://settings/';
  assert.equal((await s.command({ action: 'read', tab: 11 })).ok, false);
  s.tabs.get(12).incognito = true;
  assert.equal((await s.command({ action: 'read', tab: 12 })).ok, false);
  assert.equal(s.calls.filter(c => c[0] === 'attach').length, 0);
});

test('unlisted and revoked sites cannot be read, opened or revealed in tabs',async()=>{
  const s=setup();s.setRules({});
  assert.equal((await s.command({action:'read',tab:11})).ok,false);
  assert.equal((await s.command({action:'open',url:'https://example.com/'})).ok,false);
  assert.deepEqual((await s.command({action:'tabs'})).result,[]);
  assert.equal(s.calls.length,0);
  s.setRules({'https://example.com':'allow'});s.revoke();
  assert.equal((await s.command({action:'read',tab:11})).ok,false);
});

test('raw eval, CDP, screenshots and keys have no escape hatch',async()=>{
 const s=setup();for(const action of ['eval','cdp','screenshot','key']) {
   const reply=await s.command({action,tab:11,expression:'fetch("https://bank.com")',method:'Target.createTarget'});
   assert.equal(reply.ok,false);assert.equal(reply.not_run,true);
 } assert.equal(s.calls.length,0);
});

test('approval binds one command to the agent, tab and URL and is not reusable',async()=>{
 const s=setup();s.setRules({'https://example.com':'ask'});
 const pending=s.command({action:'read',tab:12,_bridge:{connection:'b_1',epoch:'e_1',agent:'agent-b'}});
 await new Promise(resolve=>setImmediate(resolve));
 const state=vm.runInContext('status()',s.ctx);
 assert.equal(state.pendingApproval.agent,'agent-b');assert.equal(state.pendingApproval.tab,12);
 vm.runInContext('approvalWaiter(true)',s.ctx);
 assert.equal((await pending).ok,true);
 const denied=s.command({action:'read',tab:12});await new Promise(resolve=>setImmediate(resolve));
 vm.runInContext('approvalWaiter(false)',s.ctx);
 assert.equal((await denied).not_run,true);assert.equal(s.calls.length,1);
});

test('navigation during approval fails before page access',async()=>{
 const s=setup();s.setRules({'https://example.com':'ask'});
 const pending=s.command({action:'click',tab:11,selector:'#go'});await new Promise(resolve=>setImmediate(resolve));
 s.tabs.get(11).url='https://chase.com/';vm.runInContext('approvalWaiter(true)',s.ctx);
 assert.equal((await pending).not_run,true);assert.equal(s.calls.length,0);
});

test('disconnect cancels waiting approval and ignores old native commands',async()=>{
 const s=setup();s.setRules({'https://example.com':'ask'});
 const pending=s.command({action:'read',tab:11});await new Promise(resolve=>setImmediate(resolve));
 await vm.runInContext('disconnect()',s.ctx);await pending;
 await s.command({action:'open',url:'https://example.com/'});assert.equal(s.calls.length,0);
});

test('policy rejects credential URLs, insecure sites, subdomains, payment/login pages and deceptive suffixes',()=>{
 for(const url of ['https://chase.com./','https://paypal.com./','https://accounts.google.com./','https://chase.com/','https://secure.chase.com/','https://paypal.com/','https://docs.google.com/billing','https://docs.google.com/%63heckout','https://example.com/login','https://accounts.google.com/','https://bank.example.org/','http://example.com/','https://user:secret@example.com/']) assert.equal(policy.mode(url,{[new URL(url).origin]:'allow'}),'block',url);
 assert.equal(policy.mode('https://docs.google.com.evil.com/',{'https://docs.google.com':'allow'}),'block');
 assert.equal(policy.mode('https://other.docs.google.com/',{'https://docs.google.com':'allow'}),'block');
 assert.equal(policy.mode('https://docs.google.com/document/d/123',{'https://docs.google.com':'allow'}),'allow');
 assert.throws(()=>policy.entry('https://docs.google.com/path','allow'),/origin only/);
 for(const value of ['https://*/','https://*.example.com/']) assert.throws(()=>policy.entry(value,'allow'),/Wildcard/);
});

test('metadata hides Ask sites from bulk tab listing',async()=>{
 const s=setup();s.setRules({'https://example.com':'ask'});
 assert.deepEqual((await s.command({action:'tabs'})).result,[]);
});


test('redirect to Ask destination requires approval before revealing metadata',async()=>{
 const s=setup();s.setRules({'https://example.com':'allow','https://example.org':'ask'});
 s.chrome.tabs.create=async()=>{const t={id:99,windowId:1,status:'complete',url:'https://example.org/private',title:'PRIVATE'};s.tabs.set(99,t);return t;};
 const pending=s.command({action:'open',url:'https://example.com/redirect'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(vm.runInContext('pendingApproval.url',s.ctx),'https://example.org/private');
 vm.runInContext('approvalWaiter(false)',s.ctx);
 const reply=await pending;assert.equal(reply.ok,false);assert.equal(reply.not_run,false);
});

test('Allow to Ask edit during authorization cancels the old permission decision',async()=>{
 const s=setup();let checked=0;
 s.chrome.permissions.contains=async()=>{if(++checked===1) {s.setRules({'https://example.com':'ask'});vm.runInContext('policyRevision++',s.ctx);} return true;};
 const reply=await s.command({action:'read',tab:11});assert.equal(reply.not_run,true);assert.equal(s.calls.length,0);
});

test('fixed click refuses protected links and form destinations',()=>{
 const s=setup();let clicks=0;
 const link={href:'https://example.com/checkout',disabled:false,readOnly:false,getClientRects:()=>[{}],scrollIntoView(){},getBoundingClientRect:()=>({x:0,y:0,width:10,height:10}),contains:()=>false,closest:()=>link,click(){clicks++;}};
 s.ctx.location={href:'https://example.com/',origin:'https://example.com'};
 s.ctx.document={querySelector:()=>null,querySelectorAll:()=>[link],elementFromPoint:()=>link};s.ctx.getComputedStyle=()=>({visibility:'visible'});
 assert.match(vm.runInContext("pageAction('https://example.com/','click',{selector:'#buy'},Date.now()+1000)",s.ctx).error,/blocked/);
 assert.equal(clicks,0);
});

test('approval shows navigation destination and all relevant command parameters',async()=>{
 const s=setup();s.setRules({'https://example.com':'ask'});
 const pending=s.command({action:'navigate',tab:11,url:'https://example.com/delete?confirm=true'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(vm.runInContext('pendingApproval.details.url',s.ctx),'https://example.com/delete?confirm=true');
 vm.runInContext('approvalWaiter(false)',s.ctx);await pending;
});


test('form overrides, external form associations and nested spans cannot reach checkout',()=>{
 for(const nested of [false,true]) {
  const s=setup();let clicks=0;
  const control={type:'submit',form:{action:'https://example.com/safe'},hasAttribute:()=>true,formAction:'https://example.com/checkout'};
  const e={disabled:false,readOnly:false,getClientRects:()=>[{}],scrollIntoView(){},getBoundingClientRect:()=>({x:0,y:0,width:10,height:10}),contains:()=>false,closest:selector=>selector==='a[href]'?null:control,click(){clicks++;}};
  s.ctx.location={href:'https://example.com/',origin:'https://example.com'};s.ctx.document={querySelector:()=>null,querySelectorAll:()=>[e],elementFromPoint:()=>e};s.ctx.getComputedStyle=()=>({visibility:'visible'});
  const result=vm.runInContext("pageAction('https://example.com/','click',{selector:'#buy'},Date.now()+1000)",s.ctx);
  assert.equal(result.ok,false);assert.match(result.error,/blocked/);assert.equal(clicks,0);
 }
});

test('injected function checks deadline and exact document before touching DOM',()=>{
 const s=setup();s.ctx.location={href:'https://example.com/new'};
 assert.match(vm.runInContext("pageAction('https://example.com/','read',{},Date.now()+1000)",s.ctx).error,/Page changed/);
 assert.match(vm.runInContext("pageAction('https://example.com/new','read',{},Date.now()-1)",s.ctx).error,/expired/);
});


test('navigation rechecks source tab after waiting for destination approval',async()=>{
 const s=setup();s.setRules({'https://example.com':'allow','https://example.org':'ask'});
 const pending=s.command({action:'navigate',tab:11,url:'https://example.org/'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(vm.runInContext('pendingApproval.url',s.ctx),'https://example.org/');
 s.tabs.get(11).url='https://chase.com/';vm.runInContext('approvalWaiter(true)',s.ctx);
 const reply=await pending;assert.equal(reply.ok,false);assert.equal(reply.not_run,true);assert.equal(s.calls.filter(c=>c[0]==='update').length,0);
});
