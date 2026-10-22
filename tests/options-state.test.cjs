const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../extension/policy.js');

// Independent settings-state probes. Execute the whole options script, including
// draw and real event handlers, with a minimal DOM and synthetic extension RPC.
// These tests prove state/side-effect boundaries, not rendered browser geometry.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.files = [];
    this.open = false;
  }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...elements) { this.children = [...elements]; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  async dispatch(name, event = {}) {
    for (const fn of this.listeners.get(name) || []) await fn({preventDefault() {}, target: this, ...event});
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { return this.dispatch('click'); }
  focus() {}
}

const clone = value => value === undefined ? undefined : structuredClone(value);
const ready = () => ({
  settingsVersion: 1,
  connected: true,
  policyReady: true,
  rules: {'https://example.com': 'allow'},
  preferences: {background: false, showCursor: false},
  missing: [],
  policy: {
    path: '/synthetic/browser-policy.json', revision: 'before',
    policy: {version: 1, sites: {'https://example.com': 'allow'}, preferences: {background: false, showCursor: false}},
  },
});
const mutations = ['setRule', 'removeRule', 'preferences', 'replacePolicy'];
const validDocument = {version: 1, sites: {'https://example.org': 'ask'}, preferences: {background: false, showCursor: false}};

function setup(initial = ready(), manifest = {permissions: ['scripting'], optional_host_permissions: ['https://*/*']}) {
  const nodes = new Map(), calls = [], grants = [], intervals = [];
  let response = clone(initial), rulesFailure = '', editFailure = '', rulesHook = null;
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  };
  const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
  const queryAll = selectors => [...new Set(selectors.split(',').flatMap(selector => {
    const parts = selector.trim().split(/\s+/);
    if (parts.length === 1) return [node(parts[0])];
    if (parts[0] === '#rule-form' && parts[1] === 'button') return [node('#add-site-fixture')];
    return descendants(node(parts[0])).filter(element => element.tagName === parts[1].toUpperCase());
  }))];
  const ctx = vm.createContext({
    document: {querySelector: node, querySelectorAll: queryAll, createElement: tag => new Element(tag)},
    SitePolicy: policy, renderApproval() {}, setInterval: fn => intervals.push(fn), setTimeout() {},
    URL, Blob, console,
    chrome: {
      runtime: {
        getManifest: () => clone(manifest),
        sendMessage: async message => {
          calls.push(clone(message));
          if (message.type === 'rules') {
            if (rulesHook) return rulesHook(message);
            if (rulesFailure) throw new Error(rulesFailure);
            return clone(response);
          }
          if (editFailure) return {error: editFailure};
          return clone(response);
        },
      },
      permissions: {request: async request => {grants.push(clone(request)); return true;}},
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/options.js'), 'utf8'), ctx);
  const run = source => vm.runInContext(source, ctx);
  return {
    ctx, run, node, calls, grants, intervals,
    setResponse: next => {response = clone(next);},
    failRules: message => {rulesFailure = message;},
    failEdit: message => {editFailure = message;},
    rulesHook: hook => {rulesHook = hook;},
    async refresh(next) {if (arguments.length) response = clone(next); return run('refresh(true)');},
    editCalls: () => calls.filter(message => mutations.includes(message.type)),
  };
}

test('cold settings paint has a loading message rather than a false zero-site claim', async () => {
  const s = setup();
  assert.equal(s.node('#site-count').textContent, '');
  assert.match(s.node('#rules').children[0].textContent, /Loading/);
  await s.refresh();
  assert.equal(s.node('#site-count').textContent, '(1)');
  assert.equal(s.node('#show-cursor').checked, false);
  assert.equal(s.node('#background').checked, false);
});

test('legacy and future workers preserve displayable choices but cannot edit or request consent', async t => {
  for (const [name, snapshot] of [
    ['legacy', {rules: {'https://example.com': 'allow'}, missing: []}],
    ['future', {...ready(), settingsVersion: 2}],
  ]) await t.test(name, async () => {
    const s = setup(); await s.refresh(snapshot);
    assert.equal(s.node('#site-count').textContent, '(1)');
    assert.equal(s.run('state.settingsCompatible'), false);
    for (const type of mutations) await assert.rejects(s.run(`send({type:${JSON.stringify(type)},document:${JSON.stringify(validDocument)}})`), /Reload/);
    await assert.rejects(s.run("granting(SitePolicy.entry('https://example.com','allow'))"), /Reload/);
    assert.equal(s.editCalls().length, 0);
    assert.equal(s.grants.length, 0);
  });
});

test('undefined, null, array and primitive replies retain last known sites and fail closed', async t => {
  for (const [name, bad] of [['undefined', undefined], ['null', null], ['array', []], ['boolean', false], ['string', 'ready']]) {
    await t.test(name, async () => {
      const s = setup(); await s.refresh();
      await assert.rejects(s.refresh(bad), /Settings could not be read/);
      assert.equal(s.node('#site-count').textContent, '(1)');
      assert.equal(s.run('state.settingsCompatible'), false);
      assert.equal(s.node('#show-cursor').checked, false);
      assert.equal(s.node('#import').disabled, true);
      assert.equal(s.node('#export').disabled, true);
      assert.equal(s.editCalls().length, 0);
    });
  }
});

test('incomplete current-version replies never replace saved false preferences or enable edits', async t => {
  const variants = [
    ['missing preferences', value => {delete value.preferences;}],
    ['partial preferences', value => {delete value.preferences.showCursor;}],
    ['missing rules', value => {delete value.rules;}],
    ['null rules', value => {value.rules = null;}],
    ['nonboolean connected', value => {value.connected = 1;}],
    ['nonboolean policyReady', value => {value.policyReady = 1;}],
    ['missing consent list', value => {delete value.missing;}],
    ['null policy snapshot', value => {value.policy = null;}],
  ];
  for (const [name, change] of variants) await t.test(name, async () => {
    const s = setup(); await s.refresh(); const next = ready(); change(next);
    await assert.rejects(s.refresh(next), /incomplete/);
    assert.equal(s.run('state.settingsCompatible'), false);
    assert.equal(s.node('#show-cursor').checked, false);
    assert.equal(s.node('#background').checked, false);
    assert.equal(s.node('#site-count').textContent, '(1)');
    for (const type of mutations) await assert.rejects(s.run(`send({type:${JSON.stringify(type)},document:${JSON.stringify(validDocument)}})`));
    assert.equal(s.editCalls().length, 0);
  });
});

test('disconnected, stale-manifest and legacy snapshots block every mutation', async t => {
  const cases = [
    ['disconnected', {...ready(), connected: false, policyReady: false}],
    ['stale manifest', ready(), {permissions: [], optional_host_permissions: undefined}],
    ['legacy', {rules: ready().rules, missing: []}],
  ];
  for (const [name, snapshot, manifest] of cases) await t.test(name, async () => {
    const s = setup(snapshot, manifest); await s.refresh();
    for (const type of mutations) await assert.rejects(s.run(`send({type:${JSON.stringify(type)},document:${JSON.stringify(validDocument)}})`));
    assert.equal(s.editCalls().length, 0);
    assert.equal(s.grants.length, 0);
  });
});

test('an unavailable policy permits only explicit replacement, preserving false preferences for display', async () => {
  const s = setup({...ready(), policyReady: false, lastError: 'Shared policy file is missing'}); await s.refresh();
  assert.equal(s.node('#import').disabled, false);
  assert.equal(s.node('#show-cursor').disabled, true);
  assert.equal(s.node('#show-cursor').checked, false);
  for (const type of mutations.filter(type => type !== 'replacePolicy')) await assert.rejects(s.run(`send({type:${JSON.stringify(type)}})`), /missing/);
  await s.run(`task(async()=>send({type:'replacePolicy',document:${JSON.stringify(validDocument)},revision:null}))`);
  assert.deepEqual(s.editCalls().map(message => message.type), ['replacePolicy']);
  assert.equal(s.editCalls()[0].revision, null);
});

test('a rejected preference save repaints stored values, retains the failure and never replays the edit', async () => {
  const s = setup(); await s.refresh(); s.failEdit('Policy save timed out; inspect before retrying');
  s.node('#show-cursor').checked = true;
  await s.node('#show-cursor').dispatch('change');
  assert.equal(s.node('#show-cursor').checked, false);
  assert.equal(s.run('state.preferences.showCursor'), false);
  assert.match(s.node('#error').textContent, /timed out/);
  assert.equal(s.node('#saved').textContent, '');
  await s.run('refresh()');
  assert.equal(s.node('#show-cursor').checked, false);
  assert.match(s.node('#error').textContent, /timed out/);
  assert.equal(s.editCalls().length, 1);
  assert.equal(s.run('busy'), false);
  assert.equal(s.run('taskRevision'), null);
});

test('a failed post-save refresh clears success and a later read can recover without replay', async () => {
  const s = setup(); await s.refresh();
  await s.run("task(async()=>{await send({type:'preferences',preferences:{showCursor:false,background:false}});saved('Preferences saved.');})");
  s.failRules('Synthetic transport unavailable');
  await s.run("task(async()=>{await send({type:'preferences',preferences:{showCursor:false,background:false}});saved('Preferences saved.');})");
  assert.equal(s.node('#saved').textContent, '');
  assert.match(s.node('#error').textContent, /Synthetic transport/);
  assert.equal(s.node('#import').disabled, true);
  assert.equal(s.run('busy'), false);
  const edits = s.editCalls().length; s.failRules(''); await s.refresh();
  assert.equal(s.node('#import').disabled, false);
  assert.equal(s.node('#error').textContent, '');
  assert.equal(s.editCalls().length, edits);
});

test('the visible import dialog rechecks compatibility before requesting new host consent', async () => {
  const s = setup(); await s.refresh();
  s.run(`imported=SitePolicy.document(${JSON.stringify(validDocument)});importRevision='before';`);
  s.node('#import-preview').open = true;
  await s.refresh({...ready(), settingsVersion: 2});
  await s.node('#apply-policy').dispatch('click');
  assert.equal(s.grants.length, 0, 'A stale import dialog must not request host consent while the settings protocol is incompatible');
  assert.equal(s.editCalls().length, 0);
  assert.equal(s.node('#import-preview').open, true);
});

test('an already in-flight poll cannot replace the revision captured before user consent', async () => {
  const s = setup(); await s.refresh(); let releaseRead, releaseConsent;
  s.rulesHook(() => new Promise(resolve => {releaseRead = resolve;}));
  const pendingRead = s.run('refresh()');
  s.ctx.consent = new Promise(resolve => {releaseConsent = resolve;});
  const edit = s.run("task(async()=>{await consent;await send({type:'setRule',origin:'https://example.com',mode:'allow'});})");
  releaseRead({...ready(), policy: {...ready().policy, revision: 'intervening'}}); await pendingRead;
  s.rulesHook(null); releaseConsent(); await edit;
  assert.equal(s.editCalls().length, 1);
  assert.equal(s.editCalls()[0].revision, 'before');
});

test('explicit import-preview revision survives observational refreshes', async () => {
  const s = setup(); await s.refresh();
  await s.run(`task(async()=>send({type:'replacePolicy',document:${JSON.stringify(validDocument)},revision:'reviewed-preview'}))`);
  assert.equal(s.editCalls()[0].revision, 'reviewed-preview');
});
