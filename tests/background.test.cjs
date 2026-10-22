const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

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
  const chrome = {
    runtime: { id: 'test', connectNative: () => port, onMessage: event(), getPlatformInfo: async () => ({ os: 'mac' }) },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    debugger: { onDetach: event(),
      attach: async target => { calls.push(['attach', target]); },
      detach: async target => { calls.push(['detach', target]); },
      sendCommand: async (target, method, params) => {
        calls.push(['cdp', target, method, params]);
        return method === 'Runtime.evaluate' ? { result: { value: 'page A' } } : {};
      } },
    tabs: { onRemoved: event(), query: async () => [...tabs.values()],
      get: async id => { if (!tabs.has(id)) throw new Error('No tab with id: ' + id); return tabs.get(id); },
      create: async options => {
        calls.push(['create', options]);
        const tab = { id: 99, windowId: 1, status: 'complete', ...options };
        tabs.set(99, tab); return tab;
      },
      update: async (id, options) => { calls.push(['update', id, options]); Object.assign(tabs.get(id), options); return tabs.get(id); },
      remove: async id => { calls.push(['remove', id]); tabs.delete(id); } },
    windows: { update: async (...args) => { calls.push(['window', ...args]); },
      getAll: async () => [{ id: 1, focused, tabs: [...tabs.values()] }] },
  };
  const ctx = vm.createContext({ chrome, console, URL, setTimeout, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), ctx);
  vm.runInContext('connect()', ctx);
  port.onMessage.emit({ type: 'ready', session: 's1', connection: 'b_1', epoch: 'e_1' });
  async function command(payload, expires = Date.now() / 1000 + 10) {
    const id = String(replies.length);
    port.onMessage.emit({ type: 'command', id, expires, command: payload });
    await vm.runInContext('queue', ctx);
    return replies.length ? JSON.parse(JSON.stringify(replies.at(-1))) : null;
  }
  return { calls, tabs, chrome, ctx, port, command, unfocus: () => { focused = false; } };
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
  assert.equal(s.calls.find(c => c[0] === 'cdp')[1].tabId, 12);
  assert.equal((await s.command({ action: 'read', tab: 404 })).ok, false);
  assert.equal(s.calls.filter(c => c[0] === 'cdp').length, 1);
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

test('Select All uses the operating system, independently of browser brand', async () => {
  for (const [os, modifier] of [['mac', 4], ['win', 2], ['linux', 2]]) {
    const s = setup();
    s.chrome.runtime.getPlatformInfo = async () => ({ os });
    const reply = await s.command({ action: 'type', tab: 11, selector: '#query', text: 'hello' });
    assert.equal(reply.ok, true);
    const selectAll = s.calls.find(c => c[0] === 'cdp' && c[2] === 'Input.dispatchKeyEvent' && c[3].key === 'a');
    assert.equal(selectAll[3].modifiers, modifier);
  }
});

test('disconnect detaches tabs and ignores commands from the old connection', async () => {
  const s = setup();
  await s.command({ action: 'read', tab: 11 });
  await vm.runInContext('disconnect()', s.ctx);
  assert.equal(s.calls.filter(c => c[0] === 'detach').length, 1);
  await s.command({ action: 'open', url: 'https://example.com/' });
  assert.equal(s.calls.filter(c => c[0] === 'create').length, 0);
});

test('disconnect during attachment prevents the page command from running', async () => {
  const s = setup();
  let release;
  s.chrome.debugger.attach = () => new Promise(resolve => { release = resolve; });
  const pending = s.command({ action: 'read', tab: 11 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  await vm.runInContext('disconnect()', s.ctx);
  release();
  await pending;
  assert.equal(s.calls.filter(c => c[0] === 'cdp').length, 0);
  assert.equal(s.calls.filter(c => c[0] === 'detach').length, 1);
});
