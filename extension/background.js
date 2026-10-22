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

function status() {
  return { connected: !!session, connecting: !!port && !session, session, connectionId, browserEpoch, lastError, lastAction, pendingApproval };
}

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function disconnect() {
  const old = port;
  port = null;
  session = null;
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
      badge("ON", "#15803d");
    } else if (message.type === "command") {
      queue = queue.then(async () => {
        if (port !== current || !session) return;
        try {
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
    if (approvalWaiter) approvalWaiter(false);
    badge("!", "#b91c1c");
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !["popup.html", "options.html"].some(p => sender.url === chrome.runtime.getURL(p))) return;
  (async () => {
    if (message.type === "connect") connect();
    if (message.type === "disconnect") await disconnect();
    if (message.type === "rules") return { rules: await rules() };
    if (message.type === "setRule") {
      const edit=policyEdits.then(async()=>{
        const rule = SitePolicy.entry(message.origin, message.mode);
        if (rule.mode !== "block" && !await chrome.permissions.contains({ origins: [rule.pattern] })) throw new Error("Grant this host using the browser permission prompt first");
        const saved = await rules(); saved[rule.origin] = rule.mode;
        policyRevision++;
        await chrome.storage.local.set({ siteRules: saved });
        if(rule.mode === "block" && !Object.entries(saved).some(([origin,mode]) => mode !== "block" && SitePolicy.entry(origin,mode).pattern === rule.pattern)) await chrome.permissions.remove({origins:[rule.pattern]});
        if (approvalWaiter) approvalWaiter(false); // Any policy edit invalidates an outstanding decision.
        return { rules: saved };
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
  if (!session || !port || port !== executionPort || Date.now() >= expires * 1000 - 150) throw denied("Command expired or browser disconnected; no further action sent");
}
async function permitted(value) {
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

// Only this fixed function runs, in the isolated world of the top document.
// Recheck URL inside the document so navigation cannot swap an approved page.
function pageAction(expectedURL, action, args, deadline) {
  try { return {ok:true, result:run()}; } catch(error) { return {ok:false,error:error.message || String(error)}; }
  function run() {
  function unexpired() { if(!Number.isFinite(deadline) || Date.now()>=deadline) throw new Error("Command expired before page execution"); }
  unexpired();
  if (location.href !== expectedURL) throw new Error("Page changed before command; inspect and retry");
  if (document.querySelector('input[type=password],input[autocomplete^="cc-"],input[name*="cardnumber" i],iframe[src*="stripe.com"],iframe[src*="paypal.com"]')) throw new Error("Sensitive login or card form detected; handle this page manually");
  function select(selector) {
    const matches = [...document.querySelectorAll(selector)].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden");
    if (matches.length !== 1) throw new Error("Selector must match exactly one visible element; matched " + matches.length);
    const e = matches[0];
    if (e.disabled || e.readOnly) throw new Error("Element is disabled or read-only");
    e.scrollIntoView({block:"center",inline:"center"});
    const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
    if (hit !== e && !e.contains(hit)) throw new Error("Another element covers this target");
    return e;
  }
  if (action === "read") {
    function selector(el) {
      if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
      const parts=[];
      for (let e=el; e?.nodeType===1; e=e.parentElement) {
        let s=e.localName;
        if(e.parentElement) { const same=[...e.parentElement.children].filter(c=>c.localName===e.localName); if(same.length>1) s+=`:nth-of-type(${same.indexOf(e)+1})`; }
        parts.unshift(s);
      }
      return parts.join(" > ");
    }
    const elements=[...document.querySelectorAll("a,button,input,textarea,select,[role=button],[contenteditable=true]")].filter(e=>e.getClientRects().length && getComputedStyle(e).visibility!=="hidden").slice(0,180).map(e=>({selector:selector(e),tag:e.localName,type:e.getAttribute("type"),text:(e.innerText||e.getAttribute("aria-label")||e.getAttribute("placeholder")||"").slice(0,180),value:["input","textarea","select"].includes(e.localName) && e.type!=="file" ? e.value.slice(0,5000) : undefined}));
    return {title:document.title,url:location.href,text:document.body?.innerText.slice(0,20000),elements};
  }
  if (action === "scroll") { window.scrollBy({left:args.x,top:args.y,behavior:"instant"}); return {x:scrollX,y:scrollY}; }
  if (action === "click") {
    const e=select(args.selector);
    const link=e.closest("a[href]");
    const control=e.closest("button,input");
    const form=control?.form;
    const destination=link?.href || (form && ["submit","image"].includes(control.type) ? (control.hasAttribute("formaction") ? control.formAction : form.action) : null);
    if(destination) {
      const u=new URL(destination), path=decodeURIComponent(u.pathname);
      if(!/^https?:$/.test(u.protocol) || u.origin!==location.origin) throw new Error("Cross-site links/forms require an explicit open or navigate command with site approval");
      if(/(^|\/)(checkout|payments?|billing|wallet|banking|credit[-_]?cards?|signin|login|oauth|authorize)(\/|$)/i.test(path)) throw new Error("Payment, billing and sign-in links/forms are blocked");
    }
    unexpired(); e.click(); return {clicked:args.selector};
  }
  if (action === "type") {
    const e=select(args.selector);
    if (!((e.localName==="input" && ["text","search","email","url","tel","number"].includes(e.type)) || e.localName==="textarea" || e.isContentEditable)) throw new Error("Type requires an editable text field");
    unexpired(); e.focus();
    const value=(args.append ? (e.isContentEditable ? e.textContent : e.value) : "")+args.text;
    if (e.isContentEditable) { document.execCommand("selectAll",false); document.execCommand("insertText",false,value); }
    else { const proto=e.localName==="textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,"value").set.call(e,value); e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); }
    return {typed:args.text.length,selector:args.selector};
  }
  if (action === "upload") {
    const e=select(args.selector);
    if(e.localName!=="input" || e.type!=="file") throw new Error("Upload requires a file input");
    if(args.files.length>1 && !e.multiple) throw new Error("Input accepts one file");
    const data=new DataTransfer();
    for(const f of args.files) data.items.add(new File([Uint8Array.from(atob(f.data),c=>c.charCodeAt(0))],f.name,{type:f.type}));
    unexpired(); e.files=data.files; e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true}));
    return {uploaded:args.files.length};
  }
  throw new Error("Unsupported page action");
  }
}
async function instrument(id, expectedURL, action, command, expires, revision) {
  live(expires,revision); await permitted(expectedURL); live(expires,revision);
  if(action!=="read") actionStarted=true;
  const results=await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},world:"ISOLATED",func:pageAction,args:[expectedURL,action,command,expires*1000]});
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
    const revision=await authorize(command,command.url,expires); live(expires,revision);
    actionStarted = true;
    const t=await chrome.tabs.create({url:httpURL(command.url),active:true});
    await chrome.windows.update(t.windowId,{focused:true});
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
