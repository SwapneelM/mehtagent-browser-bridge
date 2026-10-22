const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function setup(stale=false) {
 const elements=new Map();
 const document={querySelector:selector=>{if(!elements.has(selector)) elements.set(selector,{textContent:'',disabled:false,classList:{toggle(){}},listeners:{},addEventListener(name,fn){this.listeners[name]=fn;}});return elements.get(selector);}};
 const created=[];
 const chrome={runtime:{getManifest:()=>stale?{permissions:['debugger','tabs','storage','nativeMessaging']}:{permissions:['nativeMessaging','scripting','storage'],optional_host_permissions:['https://*/*']},getURL:p=>'chrome-extension://test/'+p,sendMessage:async()=>({connected:false})},tabs:{create:async value=>{created.push(value);}}};
 const context=vm.createContext({chrome,document,renderApproval(){},setInterval(){}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/popup.js'),'utf8'),context);
 return {elements,created,chrome,context};
}
test('settings opens even if the browser still has a manifest without options_ui',async()=>{
 const s=setup(true);await vm.runInContext('update()',s.context);
 assert.equal(s.elements.get('#toggle').disabled,true);
 assert.match(s.elements.get('#error').textContent,/older manifest/);
 await s.elements.get('#settings').listeners.click();
 assert.equal(s.created[0].url,'chrome-extension://test/options.html');
});
test('settings failures remain visible through status polling',async()=>{
 const s=setup();s.chrome.tabs.create=async()=>{throw new Error('test failure');};
 await s.elements.get('#settings').listeners.click();await vm.runInContext('update()',s.context);
 assert.match(s.elements.get('#error').textContent,/Could not open Site permissions: test failure/);
});
test('a failed status request releases the busy state for retry',async()=>{
 const s=setup();let count=0;
 s.chrome.runtime.sendMessage=async()=>{if(++count===1)throw new Error('connection unavailable');return {connected:false};};
 await s.elements.get('#toggle').listeners.click();
 assert.equal(vm.runInContext('busy',s.context),false);
 assert.equal(s.elements.get('#toggle').disabled,false);
 assert.match(s.elements.get('#error').textContent,/connection unavailable/);
});
test('stale manifest still permits disconnecting an existing connection',async()=>{
 const s=setup(true);s.chrome.runtime.sendMessage=async()=>({connected:true});await vm.runInContext('update()',s.context);
 assert.equal(s.elements.get('#toggle').disabled,false);
});
