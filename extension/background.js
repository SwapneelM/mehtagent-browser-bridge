/* Local Browser Bridge. No web-facing listener or remotely loaded code. */
const HOST = "com.mehtagent.browser_bridge";
let port = null;
let session = null;
let connectionId = null;
let browserEpoch = null;
let lastError = "";
let lastAction = "";
let queue = Promise.resolve();
let executionPort = null;
const attached = new Set();

function status() {
  return { connected: !!session, connecting: !!port && !session, session, connectionId, browserEpoch, lastError, lastAction };
}

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function detachAll() {
  const tabs = [...attached];
  attached.clear();
  await Promise.allSettled(tabs.map(tabId => chrome.debugger.detach({ tabId })));
}

async function disconnect() {
  const old = port;
  port = null;
  session = null;
  if (old) old.disconnect();
  await detachAll();
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
          lastAction = message.command.action + " · " + new Date().toLocaleTimeString();
          const result = await execute(message.command, message.expires);
          if (port === current) current.postMessage({ type: "response", id: message.id, ok: true, result });
        } catch (error) {
          lastError = error.message || String(error);
          if (port === current) current.postMessage({ type: "response", id: message.id, ok: false, error: lastError });
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
    void detachAll();
    badge("!", "#b91c1c");
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    if (message.type === "connect") connect();
    if (message.type === "disconnect") await disconnect();
    return status();
  })().then(sendResponse, error => sendResponse({ ...status(), lastError: error.message }));
  return true;
});
chrome.debugger.onDetach.addListener(source => attached.delete(source.tabId));
chrome.tabs.onRemoved.addListener(tabId => attached.delete(tabId));

function httpURL(value) {
  const url = new URL(value);
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

async function cdp(tabId, method, params = {}) {
  if (!session || !port || port !== executionPort) throw new Error("Browser control was disconnected");
  if (!attached.has(tabId)) {
    const t = await tab(tabId);
    httpURL(t.url);
    await chrome.debugger.attach({ tabId }, "1.3");
    attached.add(tabId);
  }
  if (!session || !port || port !== executionPort) {
    await detachAll();
    throw new Error("Browser control was disconnected");
  }
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function evaluate(tabId, expression) {
  const reply = await cdp(tabId, "Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true, userGesture: true, timeout: 20000,
  });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  if (reply.result.subtype === "error") throw new Error(reply.result.description);
  return reply.result.value ?? null;
}

function call(fn, ...args) {
  return `(${fn.toString()})(...${JSON.stringify(args)})`;
}

async function loaded(id, expires) {
  const deadline = Math.min(Date.now() + 25000, expires * 1000 - 300);
  while (Date.now() < deadline) {
    const t = await tab(id);
    if (t.status === "complete") return tabInfo(t);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return tabInfo(await tab(id));
}

function pointForSelector(selector) {
  const elements = [...document.querySelectorAll(selector)].filter(e => {
    const r = e.getBoundingClientRect();
    return r.width && r.height && getComputedStyle(e).visibility !== "hidden";
  });
  if (elements.length !== 1) throw new Error(`Selector must match one visible element; matched ${elements.length}`);
  const e = elements[0];
  if (e.disabled) throw new Error("Element is disabled");
  e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = e.getBoundingClientRect();
  const x = Math.max(0, r.left) + (Math.min(innerWidth, r.right) - Math.max(0, r.left)) / 2;
  const y = Math.max(0, r.top) + (Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) / 2;
  const hit = document.elementFromPoint(x, y);
  if (hit !== e && !e.contains(hit)) throw new Error("Another element covers this target");
  return { x, y };
}

async function click(tabId, selector) {
  const point = await evaluate(tabId, call(pointForSelector, selector));
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  return { clicked: selector };
}

async function key(tabId, name, modifiers = 0) {
  const special = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35,
    PageUp: 33, PageDown: 34, Space: 32 };
  const vk = special[name] || (name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0);
  if (!vk) throw new Error("Use a named key such as Enter, Tab, ArrowDown, or one character");
  const params = { key: name === "Space" ? " " : name, windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk, modifiers };
  if (name.length === 1) params.code = /^[a-z]$/i.test(name) ? "Key" + name.toUpperCase() : "Digit" + name;
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...params,
    ...((name.toLowerCase() === "a" && (modifiers === 4 || modifiers === 2)) ? { commands: ["selectAll"] } : {}),
    ...(name === "Enter" ? { text: "\r" } : {}) });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...params });
  return { key: name, modifiers };
}

function snapshot() {
  function selector(el) {
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
    const parts = [];
    for (let e = el; e?.nodeType === 1; e = e.parentElement) {
      let s = e.localName;
      if (e.parentElement) {
        const same = [...e.parentElement.children].filter(c => c.localName === e.localName);
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(s);
    }
    return parts.join(" > ");
  }
  const elements = [...document.querySelectorAll("a,button,input,textarea,select,[role=button],[contenteditable=true]")]
    .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden")
    .slice(0, 180).map(e => ({ selector: selector(e), tag: e.localName, type: e.getAttribute("type"),
      text: (e.innerText || e.getAttribute("aria-label") || e.getAttribute("placeholder") || "").slice(0, 180),
      href: e.localName === "a" ? e.href : undefined }));
  return { title: document.title, url: location.href, text: document.body?.innerText.slice(0, 20000), elements,
    frames: [...document.querySelectorAll("iframe")].map(e => ({ src: e.src, name: e.name })) };
}

async function execute(command, expires) {
  const { action, tab: id } = command;
  if (action === "tabs") return (await chrome.tabs.query({})).filter(t => !t.incognito).map(tabInfo);
  if (action === "current") {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
    const focused = windows.find(w => w.focused && !w.incognito);
    const active = focused?.tabs.find(t => t.active);
    if (!active) throw new Error("No focused window in this profile. Focus its browser window or specify a tab ID.");
    return tabInfo(active);
  }
  if (action === "open") {
    const t = await chrome.tabs.create({ url: httpURL(command.url), active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return loaded(t.id, expires);
  }
  const t = await tab(id);
  if (action === "claim") return tabInfo(t);
  if (action === "activate") {
    await chrome.windows.update(t.windowId, { focused: true });
    return tabInfo(await chrome.tabs.update(id, { active: true }));
  }
  if (action === "close") { await chrome.tabs.remove(id); return { closed: id }; }
  if (action === "navigate") {
    await chrome.tabs.update(id, { url: httpURL(command.url) });
    return loaded(id, expires);
  }
  // Restricted browser pages and extension pages cannot be instrumented.
  httpURL(t.url);
  if (action === "read") return evaluate(id, call(snapshot));
  if (action === "eval") return evaluate(id, command.expression);
  if (action === "click") return click(id, command.selector);
  if (action === "key") return key(id, command.key, command.modifiers);
  if (action === "type") {
    await evaluate(id, call(selector => {
      const e = document.querySelector(selector);
      const allowedInput = e?.localName === "input" && !["file", "button", "submit", "reset", "checkbox", "radio", "hidden", "range", "color"].includes(e.type);
      if (!e || (!allowedInput && e.localName !== "textarea" && !e.isContentEditable) || e.readOnly || e.disabled) {
        throw new Error("Type requires an editable input, textarea, or contenteditable element");
      }
      return true;
    }, command.selector));
    await click(id, command.selector);
    if (!command.append) {
      const platform = await chrome.runtime.getPlatformInfo();
      await key(id, "a", platform.os === "mac" ? 4 : 2);
    }
    await cdp(id, "Input.insertText", { text: command.text });
    return { typed: command.text.length, selector: command.selector };
  }
  if (action === "scroll") return evaluate(id, call((x, y) => {
    window.scrollBy({ left: x, top: y, behavior: "instant" });
    return { x: scrollX, y: scrollY };
  }, command.x, command.y));
  if (action === "screenshot") {
    const options = { format: "png", captureBeyondViewport: !!command.full_page };
    if (command.full_page) {
      const { cssContentSize: size } = await cdp(id, "Page.getLayoutMetrics");
      options.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
    }
    return cdp(id, "Page.captureScreenshot", options);
  }
  if (action === "upload") {
    const { root } = await cdp(id, "DOM.getDocument", { depth: 0, pierce: true });
    const { nodeIds } = await cdp(id, "DOM.querySelectorAll", { nodeId: root.nodeId, selector: command.selector });
    if (nodeIds.length !== 1) throw new Error("Upload selector must match exactly one input element");
    await cdp(id, "DOM.setFileInputFiles", { nodeId: nodeIds[0], files: command.files });
    return { uploaded: command.files.length };
  }
  if (action === "cdp") return cdp(id, command.method, command.params);
  throw new Error("Unknown browser action: " + action);
}
