/* Local Browser Bridge. No web-facing listener or remotely loaded code. */
importScripts("policy.js");
const HOST = "com.mehtagent.browser_bridge";
let port = null;
let session = null;
let connectionId = null;
let browserEpoch = null;
let lastError = "";
let lastAction = "";
let queue = Promise.resolve();
let executionPort = null;
let actionStarted = false;
let policyRevision = 0;
let policyEdits = Promise.resolve();
let pendingApproval = null;
let approvalWaiter = null;
let policyReady = false;
let sharedPolicy = {path:"",revision:null,policy:null};
let policySync = Promise.resolve();
let policyApply = Promise.resolve();
const policyRequests = new Map();

function nativePolicy(operation, revision) {
  if(!port || !session) return Promise.reject(new Error("Connect to edit the shared policy"));
  const id=crypto.randomUUID(), current=port;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{policyRequests.delete(id);reject(new Error("Policy save timed out; refresh to inspect the file before retrying"));},10000);
    policyRequests.set(id,{resolve,reject,timer});
    try { current.postMessage({type:"policy_update",id,revision,operation}); }
    catch(error) {clearTimeout(timer);policyRequests.delete(id);reject(error);}
  });
}
function rejectPolicyRequests() {
  policyReady=false;
  for(const waiter of policyRequests.values()) {clearTimeout(waiter.timer);waiter.reject(new Error("Browser disconnected; reconnect and inspect the policy"));}
  policyRequests.clear();
}
function applyPolicy(value) {
  const apply=policyApply.then(async()=>{
    if(value.error || !value.policy) {policyReady=false;policyRevision++;if(approvalWaiter)approvalWaiter(false);throw new Error(value.error || "Shared policy file is missing; restore it and reconnect");}
    const document=SitePolicy.document(value.policy);
    const changed=sharedPolicy.revision!==value.revision || !policyReady;
    policyReady=false;
    if(changed) {policyRevision++;if(approvalWaiter) approvalWaiter(false);}
    const previous=await rules();
    sharedPolicy={path:value.path,revision:value.revision,policy:document};
    await chrome.storage.local.set({siteRules:document.sites,preferences:document.preferences,sharedPolicy});
    // Removing a rule also drops unused optional browser consent. Consent is
    // never requested by a host update, file watcher, or agent command.
    for(const [origin,mode] of Object.entries(previous)) {
      if(mode==="block") continue;
      const pattern=SitePolicy.entry(origin,mode).pattern;
      if(!Object.entries(document.sites).some(([o,m])=>m!=="block" && SitePolicy.entry(o,m).pattern===pattern) && !chrome.runtime.getManifest?.().host_permissions?.includes(pattern)) await chrome.permissions.remove({origins:[pattern]});
    }
    policyReady=true;
  });
  policyApply=apply.catch(()=>{});
  return apply;
}
async function initializePolicy(value) {
  policyReady=false;
  if(value && !value.error && value.policy===null) {
    const saved=await chrome.storage.local.get(["siteRules","preferences","sharedPolicy"]);
    if(saved.sharedPolicy?.policy) throw new Error("Shared policy file was removed; restore it and reconnect");
    const document=SitePolicy.document({version:1,sites:saved.siteRules || {},preferences:saved.preferences || {}});
    value=await nativePolicy({migrate:document},null);
  }
  if(value?.error && value.policy) value={...value,error:undefined}; // Another profile may have migrated first.
  await applyPolicy(value || {error:"Native host needs updating before shared policy can be used"});
}
async function policyState() {
  const cached=await chrome.storage.local.get(["siteRules","preferences","sharedPolicy"]);
  const missing=[];
  for(const [origin,mode] of Object.entries(cached.siteRules || {})) {
    if(mode!=="block" && !await chrome.permissions.contains({origins:[SitePolicy.entry(origin,mode).pattern]})) missing.push(origin);
  }
  return {...status(),rules:cached.siteRules || {},preferences:cached.preferences || SitePolicy.defaults,
    policy:cached.sharedPolicy || {path:sharedPolicy.path,revision:null,policy:null},missing};
}

function status() {
  return { connected: !!session, connecting: !!port && !session, session, connectionId, browserEpoch, lastError, lastAction, pendingApproval, policyReady };
}

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function disconnect() {
  const old = port;
  port = null;
  session = null;
  rejectPolicyRequests();
  if (old) old.disconnect();
  if (approvalWaiter) approvalWaiter(false);
  badge("", "#64748b");
}

function connect() {
  if (port) return;
  lastError = "";
  const current = chrome.runtime.connectNative(HOST);
  port = current;
  current.onMessage.addListener(message => {
    if (port !== current) return;
    if (message.type === "connected") {
      (async () => {
        const saved = await chrome.storage.local.get("connectionId");
        const transient = await chrome.storage.session.get("browserEpoch");
        connectionId = saved.connectionId || "b_" + crypto.randomUUID();
        browserEpoch = transient.browserEpoch || crypto.randomUUID();
        await chrome.storage.local.set({ connectionId });
        await chrome.storage.session.set({ browserEpoch });
        if (port === current) current.postMessage({ type: "identify", connection: connectionId, epoch: browserEpoch });
      })().catch(error => { lastError = error.message; void disconnect(); });
    } else if (message.type === "ready") {
      connectionId = message.connection;
      browserEpoch = message.epoch;
      session = message.session;
      policySync=initializePolicy(message.policy).then(()=>{badge("ON", "#15803d");},error=>{lastError=error.message;policyReady=false;badge("!","#b91c1c");});
    } else if (message.type === "policy_result") {
      const waiter=policyRequests.get(message.id);
      if(waiter) {clearTimeout(waiter.timer);policyRequests.delete(message.id);waiter.resolve(message);}
    } else if (message.type === "policy") {
      policySync=policySync.then(()=>applyPolicy(message)).catch(error=>{lastError=error.message;policyReady=false;badge("!","#b91c1c");});
    } else if (message.type === "command") {
      queue = queue.then(async () => {
        if (port !== current || !session) return;
        try {
          await policySync;
          if (Date.now() >= message.expires * 1000) throw new Error("Command expired before execution");
          if (message.command._bridge && (message.command._bridge.connection !== connectionId || message.command._bridge.epoch !== browserEpoch)) {
            throw new Error("Browser identity changed; recover before continuing");
          }
          executionPort = current;
          actionStarted = false;
          lastError = "";
          lastAction = message.command.action + " · " + new Date().toLocaleTimeString();
          const result = await execute(message.command, message.expires);
          if (port === current) current.postMessage({ type: "response", id: message.id, ok: true, result });
        } catch (error) {
          lastError = error.message || String(error);
          if (port === current) current.postMessage({ type: "response", id: message.id, ok: false, error: lastError, not_run: error.notRun === true && !actionStarted });
        }
      }).catch(error => { lastError = String(error); });
    }
  });
  current.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    if (port !== current) return;
    lastError = error?.message || "Browser connection closed";
    port = null;
    session = null;
    rejectPolicyRequests();
    if (approvalWaiter) approvalWaiter(false);
    badge("!", "#b91c1c");
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !["popup.html", "options.html"].some(p => sender.url?.split("#")[0] === chrome.runtime.getURL(p))) return;
  (async () => {
    if (message.type === "connect") connect();
    if (message.type === "disconnect") await disconnect();
    if (message.type === "rules") return policyState();
    if (["setRule","removeRule","replacePolicy","preferences"].includes(message.type)) {
      const edit=policyEdits.then(async()=>{
        await policySync;
        if(!session || !port) throw new Error("Connect to edit the shared policy");
        // Invalid/missing files may be repaired only through explicit import.
        if(!policyReady && message.type!=="replacePolicy") throw new Error("Shared policy is unavailable; fix the file or import a valid policy");
        let operation;
        if(message.type==="replacePolicy") {
          const document=SitePolicy.document(message.document);
          for(const [origin,mode] of Object.entries(document.sites)) if(mode!=="block" && !await chrome.permissions.contains({origins:[SitePolicy.entry(origin,mode).pattern]})) throw new Error("Grant the imported sites through the browser prompt first");
          operation={replace:document};
        } else if(message.type==="preferences") {
          const document=SitePolicy.document({version:1,sites:{},preferences:message.preferences});
          operation={preferences:document.preferences};
        } else {
          const rule=SitePolicy.entry(message.origin,message.type==="removeRule" ? "block" : message.mode);
          if(rule.mode!=="block" && !await chrome.permissions.contains({origins:[rule.pattern]})) throw new Error("Grant this host using the browser permission prompt first");
          operation={site:{origin:rule.origin,mode:message.type==="removeRule" ? null : rule.mode}};
        }
        if(!Object.hasOwn(message,"revision")) throw new Error("Refresh Site permissions before applying this edit");
        const result=await nativePolicy(operation,message.revision);
        if(result.error) {if(result.policy) await applyPolicy({...result,error:undefined});throw new Error(result.error);}
        await applyPolicy(result);
        return policyState();
      });
      policyEdits=edit.catch(()=>{});
      return edit;
    }
    if (message.type === "approval" && pendingApproval?.id === message.id && approvalWaiter) approvalWaiter(message.allow === true);
    return status();
  })().then(sendResponse, error => sendResponse({ ...status(), error: error.message, lastError: error.message }));
  return true;
});
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

async function rules() { return (await chrome.storage.local.get("siteRules")).siteRules || {}; }
function denied(message) { const e = new Error(message); e.notRun = true; return e; }
function live(expires, revision = policyRevision) {
  if (revision !== policyRevision) throw denied("Site policy changed; inspect permissions before retrying");
  if (!policyReady) throw denied("Shared site policy is unavailable; inspect Site permissions");
  if (!session || !port || port !== executionPort || Date.now() >= expires * 1000 - 150) throw denied("Command expired or browser disconnected; no further action sent");
}
async function permitted(value) {
  if(!policyReady) throw denied("Shared site policy is unavailable; inspect Site permissions");
  const mode = SitePolicy.mode(value, await rules());
  if (mode === "block") throw denied("Website blocked. Open Site permissions in the extension to grant this exact host. " + (SitePolicy.hardBlock(value) || ""));
  const u = SitePolicy.url(value);
  if (!await chrome.permissions.contains({ origins: [u.protocol + "//" + u.hostname + "/*"] })) throw denied("Browser site grant is missing; grant it in Site permissions");
  return mode;
}
async function approval(command, url, expires) {
  const id = crypto.randomUUID();
  pendingApproval = { id, agent: command._bridge?.agent || "unknown", action: command.action, tab: command.tab ?? "new tab", url,
    details: Object.fromEntries(Object.entries(command).filter(([key])=>key!=="_bridge" && key!=="files")), files: (command.files || []).map(f => ({name:f.name,type:f.type,sha256:f.sha256})), expires };
  badge("ASK", "#92400e");
  const approved = await new Promise(resolve => {
    const timer = setTimeout(() => finish(false), Math.max(0, expires * 1000 - Date.now() - 250));
    function finish(value) { clearTimeout(timer); approvalWaiter = null; pendingApproval = null; resolve(value); }
    approvalWaiter = finish;
  });
  badge(session ? "ON" : "", "#15803d");
  if (!approved) throw denied("Command denied or approval expired; no action sent");
}
async function authorize(command, url, expires) {
  const revision=policyRevision;
  live(expires,revision);
  if (await permitted(url) === "ask") await approval(command, url, expires);
  live(expires,revision); await permitted(url); live(expires,revision);
  return revision;
}
function httpURL(value) {
  const url = SitePolicy.url(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https websites are supported");
  return url.href;
}

function tabInfo(t) {
  return { id: t.id, windowId: t.windowId, title: t.title, url: t.url, active: t.active, status: t.status };
}

async function tab(id) {
  if (!Number.isInteger(id)) throw new Error("A tab ID is required");
  const t = await chrome.tabs.get(id);
  if (t.incognito) throw new Error("Private browsing is not supported");
  return t;
}

// Serialized into the isolated world. No page-provided JavaScript is evaluated.
function pageAction(expectedURL, action, args, deadline) {
  try { return {ok:true,result:run()}; } catch(error) { return {ok:false,error:error.message || String(error)}; }
  function run() {
    function check() {
      if(!Number.isFinite(deadline) || Date.now()>=deadline) throw new Error("Command expired before page execution");
      if(location.href!==expectedURL) throw new Error("Page changed before command; inspect and retry");
    }
    check();
    const sensitive='input[type=password],input[autocomplete^="cc-"],input[name*="cardnumber" i],iframe[src*="stripe.com"],iframe[src*="paypal.com"]';
    if(document.querySelector(sensitive)) throw new Error("Sensitive login or card form detected; handle this page manually");
    const limit=(value,fallback,max)=>Number.isInteger(value) && value>=0 ? Math.min(value,max) : fallback;
    const visible=e=>e.getClientRects().length && e.ownerDocument.defaultView.getComputedStyle(e).visibility!=="hidden" && !e.closest('[hidden],[aria-hidden="true"]');
    function css(e) {
      const root=e.getRootNode();
      if(e.id && root.querySelectorAll('#'+CSS.escape(e.id)).length===1) return '#'+CSS.escape(e.id);
      const parts=[];
      for(let n=e;n?.nodeType===1;n=n.parentElement){let s=n.localName;if(n.parentElement){const peers=[...n.parentElement.children].filter(c=>c.localName===n.localName);if(peers.length>1)s+=`:nth-of-type(${peers.indexOf(n)+1})`;}parts.unshift(s);}
      return parts.join(' > ');
    }
    function childRoot(e) {
      if(e.shadowRoot) return e.shadowRoot;
      if(e.localName==='iframe') {
        try { const doc=e.contentDocument;if(doc && doc.location.origin===location.origin && !/(^|\/)(checkout|payments?|billing|wallet|banking|credit[-_]?cards?|signin|login|oauth|authorize)(\/|$)/i.test(decodeURIComponent(doc.location.pathname)))return doc; } catch {}
      }
      return null;
    }
    function protect(root) {if(root.querySelector(sensitive))throw new Error("Sensitive login or card form detected; handle this page manually");}
    function query(selector) {
      if(typeof selector!=='string' || !selector || selector.length>2048) throw new Error("Provide a CSS selector of at most 2048 characters");
      const segments=selector.split(' >>> ');let roots=[document],matches=[];
      if(segments.length>16)throw new Error("Selector has too many shadow/frame levels");
      for(let i=0;i<segments.length;i++) {
        matches=[];
        for(const root of roots){protect(root);matches.push(...root.querySelectorAll(segments[i]));}
        if(matches.length>10000)throw new Error("Selector is too broad; scope the target");
        if(i<segments.length-1)roots=matches.map(childRoot).filter(Boolean);
      }
      return matches;
    }
    const role=e=>e.getAttribute('role') || ({button:'button',a:e.hasAttribute('href')?'link':'',textarea:'textbox',select:'combobox',input:['button','submit','reset'].includes(e.type)?'button':e.type==='checkbox'?'checkbox':e.type==='radio'?'radio':e.type==='file'?'': 'textbox'}[e.localName] || (e.isContentEditable?'textbox':''));
    function name(e) {
      const labelled=e.getAttribute('aria-labelledby');
      if(labelled){const value=labelled.split(/\s+/).map(id=>e.getRootNode().getElementById(id)?.textContent || '').join(' ').trim();if(value)return value;}
      return (e.getAttribute('aria-label') || (e.labels?.length ? [...e.labels].map(l=>l.innerText).join(' ') : '') || e.getAttribute('alt') || e.innerText || e.getAttribute('placeholder') || (['button','submit','reset'].includes(e.type)?e.value:'') || e.getAttribute('title') || '').trim();
    }
    function collect(scope,prefix='',depth=0,result=[]) {
      if(depth>16)throw new Error("DOM nesting limit reached; use a narrower selector");
      protect(scope);
      const entries=scope.nodeType===1 ? [scope,...scope.querySelectorAll('*')] : [...scope.querySelectorAll('*')];
      for(const e of entries){
        if(!visible(e))continue;
        if(++collect.visited>40000)throw new Error("DOM is too large; use read --selector to scope it");
        const path=prefix+css(e);
        if(e.matches('a,button,input,textarea,select,[role],[contenteditable="true"],[tabindex]'))result.push({e,path});
        const child=childRoot(e);if(child)collect(child,path+' >>> ',depth+1,result);
      }
      return result;
    }
    collect.visited=0;
    function deepHit(root,x,y) {let hit=root.elementFromPoint(x,y);while(hit?.shadowRoot){const next=hit.shadowRoot.elementFromPoint(x,y);if(!next || next===hit)break;hit=next;}return hit;}
    function select() {
      let matches;
      if(args.role || typeof args.name==='string') {
        matches=collect(document).filter(({e})=>(!args.role || role(e)===args.role) && (typeof args.name!=='string' || name(e)===args.name)).map(v=>v.e);
        if(args.selector) {const scoped=new Set(query(args.selector));matches=matches.filter(e=>scoped.has(e));}
      } else matches=query(args.selector).filter(visible);
      if(matches.length!==1) throw new Error("Selector must match exactly one visible element; matched "+matches.length);
      const e=matches[0];
      if(e.disabled || e.readOnly || e.getAttribute('aria-disabled')==='true')throw new Error("Element is disabled or read-only");
      e.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
      const r=e.getBoundingClientRect(),hit=deepHit(e.ownerDocument,r.x+r.width/2,r.y+r.height/2);
      if(hit!==e && !e.contains(hit))throw new Error("Another element covers this target");
      let doc=e.ownerDocument;
      while(doc!==document){const f=doc.defaultView.frameElement,fr=f.getBoundingClientRect(),over=deepHit(f.ownerDocument,fr.x+fr.width/2,fr.y+fr.height/2);if(over!==f && !f.contains(over))throw new Error("Another element covers the target frame");doc=f.ownerDocument;}
      return e;
    }
    function cursor(e,label) {
      if(args.showCursor!==true){document.getElementById('__mehtagent_cursor__')?.remove();return;}
      let host=document.getElementById('__mehtagent_cursor__');if(host)host.remove();
      host=document.createElement('div');host.id='__mehtagent_cursor__';host.setAttribute('aria-hidden','true');
      host.style.cssText='all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;';
      const shadow=host.attachShadow({mode:'closed'}),marker=document.createElement('div');
      const agent=String(args._bridge?.agent || 'agent');let hash=0;for(const c of agent)hash=(hash*31+c.charCodeAt(0))|0;
      const color=`hsl(${Math.abs(hash)%360} 75% 35%)`;
      let r=e.getBoundingClientRect(),x=r.left,y=r.top,doc=e.ownerDocument;
      while(doc!==document){const f=doc.defaultView.frameElement,fr=f.getBoundingClientRect();x+=fr.left+f.clientLeft;y+=fr.top+f.clientTop;doc=f.ownerDocument;}
      x=Math.max(4,Math.min(innerWidth-24,x));y=Math.max(4,Math.min(innerHeight-30,y));
      marker.style.cssText=`position:absolute;left:${x}px;top:${y}px;max-width:${Math.max(0,innerWidth-x-4)}px;color:white;background:${color};font:14px/1.4 system-ui;border:2px solid white;border-radius:5px;padding:4px 7px;box-shadow:0 1px 5px #0006;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;pointer-events:none;animation:mehtagent-hide 1.8s forwards;`;
      host.dataset.agent=agent.slice(0,36);host.dataset.action=label;host.dataset.x=String(x);host.dataset.y=String(y);
      marker.textContent='↖ '+agent.slice(0,36)+' · '+label;
      const style=document.createElement('style');style.textContent='@keyframes mehtagent-hide{0%,80%{opacity:1}100%{opacity:0}}';
      shadow.append(style,marker);document.documentElement.append(host);setTimeout(()=>host.remove(),1900);
    }
    if(action==='read') {
      let scope=document,prefix='';
      if(args.selector){const found=query(args.selector).filter(visible);if(found.length!==1)throw new Error('Read scope must match exactly one visible element; matched '+found.length);scope=found[0];const pieces=args.selector.split(' >>> ');prefix=pieces.length>1 ? pieces.slice(0,-1).join(' >>> ')+' >>> ' : '';}
      const all=collect(scope,prefix).filter(({e})=>(!args.role || role(e)===args.role) && (typeof args.name!=='string' || name(e)===args.name));
      const chunks=[];
      function text(root,depth=0){if(depth>16)return;const base=root.nodeType===9 ? root.body : root;chunks.push(String(base?.value ?? base?.innerText ?? base?.textContent ?? '').slice(0,500000));for(const e of [...(root.nodeType===1?[root]:[]),...root.querySelectorAll('*')]){const child=childRoot(e);if(child)text(child,depth+1);}}
      text(scope);
      const full=chunks.join('\n').slice(0,500000),offset=limit(args.offset,0,500000),size=limit(args.limit,20000,40000);
      const start=limit(args.element_offset,0,40000),count=limit(args.element_limit,180,500),elements=[];let budget=40000;
      for(const {e,path} of all.slice(start,start+count)){
        const item={selector:path,tag:e.localName,role:role(e),name:name(e).slice(0,300),type:e.getAttribute('type'),text:(e.innerText || name(e)).slice(0,180),value:['input','textarea','select'].includes(e.localName) && !['file','password'].includes(e.type)?String(e.value).slice(0,5000):undefined};
        const n=JSON.stringify(item).length;if(n>budget)break;budget-=n;elements.push(item);
      }
      let html;
      if(args.html){const clone=(scope.nodeType===9 ? scope.body : scope).cloneNode(true);for(const e of clone.querySelectorAll('script,style,iframe,object,embed,link,meta'))e.remove();for(const e of [clone,...clone.querySelectorAll('*')])for(const a of [...e.attributes])if(a.name.startsWith('on') || a.name==='srcdoc')e.removeAttribute(a.name);html=clone.outerHTML.slice(0,20000);}
      const next=offset+size<full.length ? offset+size : null;
      return {title:document.title,url:location.href,text:full.slice(offset,offset+size),offset,totalText:full.length,textCapped:chunks.reduce((n,c)=>n+c.length,0)>=500000,nextOffset:next,html,elements,totalElements:all.length,nextElementOffset:start+elements.length<all.length ? start+elements.length : null};
    }
    if(action==='scroll') {
      let e;
      if(args.selector)e=select();
      else e=document.scrollingElement;
      check();cursor(e,'scroll');e.scrollBy({left:args.x || 0,top:args.y || 0,behavior:'instant'});return {x:e.scrollLeft,y:e.scrollTop};
    }
    const e=select(),win=e.ownerDocument.defaultView,doc=e.ownerDocument;
    if(action==='click') {
      const link=e.closest('a[href]'),control=e.closest('button,input'),form=control?.form;
      const destination=link?.href || (form && ['submit','image'].includes(control.type) ? (control.hasAttribute('formaction')?control.formAction:form.action) : null);
      if(destination){const u=new URL(destination),path=decodeURIComponent(u.pathname);if(!/^https?:$/.test(u.protocol) || u.origin!==location.origin)throw new Error('Cross-site links/forms require an explicit open or navigate command with site approval');if(/(^|\/)(checkout|payments?|billing|wallet|banking|credit[-_]?cards?|signin|login|oauth|authorize)(\/|$)/i.test(path))throw new Error('Payment, billing and sign-in links/forms are blocked');}
      check();cursor(e,'click');const r=e.getBoundingClientRect(),init={bubbles:true,composed:true,cancelable:true,view:win,clientX:r.x+r.width/2,clientY:r.y+r.height/2,button:0};
      for(const kind of ['pointerover','mouseover','pointerdown','mousedown']){check();const EventClass=kind.startsWith('pointer')?win.PointerEvent:win.MouseEvent;e.dispatchEvent(new EventClass(kind,{...init,pointerId:1,pointerType:'mouse',isPrimary:true,buttons:kind.endsWith('down')?1:0}));}
      e.focus({preventScroll:true});
      for(const kind of ['pointerup','mouseup']){check();const EventClass=kind.startsWith('pointer')?win.PointerEvent:win.MouseEvent;e.dispatchEvent(new EventClass(kind,{...init,pointerId:1,pointerType:'mouse',isPrimary:true,buttons:0}));}
      check();e.click();return {clicked:args.selector || {role:args.role,name:args.name}};
    }
    if(action==='type') {
      const editor=e.closest('.monaco-editor') || (e.querySelectorAll('.monaco-editor').length===1 ? e.querySelector('.monaco-editor') : null);
      if(typeof args.text!=='string')throw new Error('Text must be a string');
      if(editor) {
        const input=editor.querySelector('textarea.inputarea');
        if(!input || input.disabled || input.readOnly || editor.classList.contains('readonly'))throw new Error('This Monaco editor does not expose an editable textarea adapter');
        check();cursor(e,'type');input.focus({preventScroll:true});
        const mac=/mac/i.test(win.navigator.userAgentData?.platform || win.navigator.platform || '');
        for(const kind of ['keydown','keyup']){check();input.dispatchEvent(new win.KeyboardEvent(kind,{bubbles:true,composed:true,cancelable:true,key:'a',code:'KeyA',keyCode:65,which:65,metaKey:mac,ctrlKey:!mac}));}
        if(args.append)for(const kind of ['keydown','keyup']){check();input.dispatchEvent(new win.KeyboardEvent(kind,{bubbles:true,composed:true,cancelable:true,key:'ArrowRight',code:'ArrowRight',keyCode:39,which:39}));}
        check();
        input.setRangeText(args.text,input.selectionStart,input.selectionEnd,'end');
        input.dispatchEvent(new win.InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:args.text}));
        return {typed:args.text.length,selector:args.selector,adapter:'monaco-textarea'};
      }
      if(!((e.localName==='input' && ['text','search','email','url','tel','number'].includes(e.type)) || e.localName==='textarea' || e.isContentEditable))throw new Error('Type requires an editable text field');
      check();cursor(e,'type');e.focus({preventScroll:true});
      if(!e.dispatchEvent(new win.InputEvent('beforeinput',{bubbles:true,composed:true,cancelable:true,inputType:args.append?'insertText':'insertReplacementText',data:args.text})))throw new Error('Page cancelled text input');
      check();const value=(args.append ? (e.isContentEditable?e.innerText:e.value):'')+args.text;
      if(e.isContentEditable){e.innerText=value;const selection=win.getSelection(),range=doc.createRange();range.selectNodeContents(e);range.collapse(false);selection.removeAllRanges();selection.addRange(range);e.dispatchEvent(new win.InputEvent('input',{bubbles:true,composed:true,inputType:args.append?'insertText':'insertReplacementText',data:args.text}));}
      else {const proto=e.localName==='textarea'?win.HTMLTextAreaElement.prototype:win.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new win.InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:args.text}));e.dispatchEvent(new win.Event('change',{bubbles:true}));}
      return {typed:args.text.length,selector:args.selector};
    }
    if(action==='upload') {
      if(e.localName!=='input' || e.type!=='file')throw new Error('Upload requires a file input');
      if(args.files.length>1 && !e.multiple)throw new Error('Input accepts one file');
      const data=new win.DataTransfer();for(const f of args.files)data.items.add(new win.File([Uint8Array.from(atob(f.data),c=>c.charCodeAt(0))],f.name,{type:f.type}));
      check();cursor(e,'upload');e.files=data.files;e.dispatchEvent(new win.Event('input',{bubbles:true}));e.dispatchEvent(new win.Event('change',{bubbles:true}));return {uploaded:args.files.length};
    }
    throw new Error('Unsupported page action');
  }
}

async function instrument(id, expectedURL, action, command, expires, revision) {
  const preferences=(await chrome.storage.local.get("preferences")).preferences || SitePolicy.defaults;
  live(expires,revision); await permitted(expectedURL); live(expires,revision);
  if(action!=="read") actionStarted=true;
  const results=await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},world:"ISOLATED",func:pageAction,args:[expectedURL,action,{...command,showCursor:preferences.showCursor},expires*1000]});
  const outcome=results[0]?.result;
  if(results.length!==1 || outcome?.ok!==true) throw new Error(outcome?.error || "Page command failed without a result");
  return outcome.result;
}

async function loaded(id, expires, command) {
  const deadline = Math.min(Date.now() + 25000, expires * 1000 - 300);
  while (Date.now() < deadline) {
    const t = await tab(id);
    if (t.status === "complete") { await permitted(t.url); if(t.url!==command.url) await authorize(command,t.url,expires); return tabInfo(t); }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const final=await tab(id); await permitted(final.url); if(final.url!==command.url) await authorize(command,final.url,expires); return tabInfo(final);
}

async function execute(command, expires) {
  const { action, tab: id } = command;
  if (["eval", "cdp", "key", "screenshot"].includes(action)) throw denied("This command is disabled in site-scoped mode. Use fixed page commands; screenshots and trusted keys need manual browser interaction.");
  if (action === "tabs") {
    const visible=[];
    for(const t of await chrome.tabs.query({})) { if(t.incognito || !t.url) continue; try { if(await permitted(t.url) === "allow") visible.push(tabInfo(t)); } catch {} }
    return visible;
  }
  if (action === "current") {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
    const active=windows.find(w=>w.focused && !w.incognito)?.tabs.find(t=>t.active);
    if(!active) throw denied("No focused window in this profile. Focus its browser window or specify a tab ID.");
    await authorize(command,active.url,expires); return tabInfo(active);
  }
  if (action === "open") {
    const revision=await authorize(command,command.url,expires);
    const preferences=(await chrome.storage.local.get("preferences")).preferences || SitePolicy.defaults;
    live(expires,revision);
    actionStarted = true;
    const active=command.foreground===true || preferences.background===false;
    const t=await chrome.tabs.create({url:httpURL(command.url),active});
    if(active) await chrome.windows.update(t.windowId,{focused:true});
    return loaded(t.id,expires,command);
  }
  const t=await tab(id);
  const revision=await authorize(command,t.url,expires);
  const current=await tab(id);
  if(current.url!==t.url || current.pendingUrl) throw denied("Page changed while awaiting permission; no action sent");
  if(action==="claim") return tabInfo(current);
  if(action==="activate") { live(expires,revision); actionStarted=true; await chrome.windows.update(t.windowId,{focused:true}); return tabInfo(await chrome.tabs.update(id,{active:true})); }
  if(action==="close") { live(expires,revision); actionStarted=true; await chrome.tabs.remove(id); return {closed:id}; }
  if(action==="navigate") {
    if(SitePolicy.url(command.url).origin!==SitePolicy.url(t.url).origin) await authorize(command,command.url,expires);
    else await permitted(command.url);
    const beforeNavigate=await tab(id);
    if(beforeNavigate.url!==t.url || beforeNavigate.pendingUrl) throw denied("Page changed during destination approval; no action sent");
    live(expires,revision); actionStarted=true; await chrome.tabs.update(id,{url:httpURL(command.url)}); return loaded(id,expires,command);
  }
  if(!["read","click","type","scroll","upload"].includes(action)) throw denied("Unknown browser action: "+action);
  return instrument(id,t.url,action,command,expires,revision);
}
