const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

// Execute the real settings logic, stopping before DOM event wiring. Rendering
// is stubbed so this test isolates overlapping policy reads and user consent.
function setup(){
 const source=fs.readFileSync(path.join(__dirname,'../extension/options.js'),'utf8');
 const end=source.indexOf('for(const suggestion of SitePolicy.suggestions)');assert.ok(end>0);
 const calls=[],nodes=new Map();let firstRules,reads=0;
 const current={rules:{'https://example.com':'block'},preferences:{background:true,showCursor:true},policy:{revision:'intervening'},missing:[],connected:true,policyReady:true};
 const ctx=vm.createContext({document:{querySelector:s=>{if(!nodes.has(s))nodes.set(s,{textContent:''});return nodes.get(s);}},SitePolicy:{defaults:{background:true,showCursor:true}},renderApproval(){},chrome:{runtime:{getManifest:()=>({permissions:['scripting'],optional_host_permissions:['https://*/*']}),sendMessage:message=>{
  calls.push(message);
  if(message.type==='rules' && ++reads===1)return new Promise(resolve=>{firstRules=resolve;});
  return Promise.resolve(current);
 }}}});
 vm.runInContext(source.slice(0,end),ctx);vm.runInContext("draw=()=>{};state={policy:{revision:'before'},rules:{'https://example.com':'allow'},preferences:{}}",ctx);
 return {ctx,calls,current,resolvePoll:()=>firstRules(current)};
}

test('an already pending refresh cannot change the revision captured before browser consent',async()=>{
 const s=setup();let consent;
 s.ctx.consent=new Promise(resolve=>{consent=resolve;});
 const poll=vm.runInContext('refresh()',s.ctx);
 const task=vm.runInContext("task(async()=>{await consent;await send({type:'setRule',origin:'https://example.com',mode:'allow'});})",s.ctx);
 s.resolvePoll();await poll;
 assert.equal(vm.runInContext('state.policy.revision',s.ctx),'intervening');
 consent();await task;
 assert.equal(s.calls.find(c=>c.type==='setRule').revision,'before');
});

test('explicit import-preview revision wins over the current settings revision',async()=>{
 const s=setup();const poll=vm.runInContext('refresh()',s.ctx);s.resolvePoll();await poll;
 await vm.runInContext("task(async()=>{await send({type:'replacePolicy',document:{version:1,sites:{}},revision:'preview'});})",s.ctx);
 assert.equal(s.calls.find(c=>c.type==='replacePolicy').revision,'preview');
});
