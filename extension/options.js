const $=selector=>document.querySelector(selector);
const names={allow:"Allow",ask:"Ask every command",block:"Block"};
const explanations={allow:"Allow: agents can read and act on this site.",ask:"Ask: approve every command before it runs.",block:"Block: agents cannot access this site."};
const manifest=chrome.runtime.getManifest();
const reloadNeeded=!manifest.permissions?.includes("scripting") || !manifest.optional_host_permissions;
const SETTINGS_VERSION=1;
const reloadMessage="Reload Browser Bridge on your browser’s Extensions page to finish updating. Your saved sites are preserved.";
let state={rules:{},preferences:{...SitePolicy.defaults},missing:[],settingsCompatible:false,loading:true},signature="",removed=null,imported=null,importRevision=null,taskRevision=null,busy=false,refreshError="";
function error(message){$("#error").textContent=message || "";if(message)$("#saved").textContent="";}
function saved(message){$("#saved").textContent=message;}
function requireEditable(kind){if(!(kind==="replacePolicy" ? canRestore() : canEdit()))throw new Error(!state.settingsCompatible || reloadNeeded ? reloadMessage : state.lastError || "Connect to edit the shared policy.");}
async function send(message){if(["setRule","removeRule","replacePolicy","preferences"].includes(message.type)){requireEditable(message.type);if(!Object.hasOwn(message,"revision"))message={...message,revision:taskRevision};}const result=await chrome.runtime.sendMessage(message);if(!result || typeof result!=="object" || Array.isArray(result))throw new Error("Settings could not be read. Reconnect Browser Bridge and inspect your saved sites.");if(result.error)throw new Error(result.error);return result;}
async function granting(rule){requireEditable();if(rule.mode!=="block" && !await chrome.permissions.request({origins:[rule.pattern]}))throw new Error("Browser permission was declined; the site rule was not changed");}
async function task(work){if(busy)return;taskRevision=state.policy?.revision;busy=true;error("");saved("");try{await work();await refresh(true);}catch(e){const message=e.message;signature="";try{await refresh(true);}catch{}error(message);}finally{busy=false;taskRevision=null;}}
function element(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function canEdit(){return state.settingsCompatible && state.connected && state.policyReady && !reloadNeeded;}
function canRestore(){return state.settingsCompatible && state.connected && !reloadNeeded;}
function normalize(next){const complete=typeof next.connected==="boolean" && typeof next.policyReady==="boolean" && Array.isArray(next.missing) && next.policy!==null && typeof next.policy==="object" && !Array.isArray(next.policy) && next.rules!==null && typeof next.rules==="object" && !Array.isArray(next.rules) && next.preferences!==null && typeof next.preferences==="object" && !Array.isArray(next.preferences) && Object.keys(SitePolicy.defaults).every(key=>typeof next.preferences[key]==="boolean");if(next.settingsVersion===SETTINGS_VERSION && !complete)throw new Error("Settings are incomplete. Reconnect Browser Bridge and inspect your saved sites.");const document=SitePolicy.document({version:1,sites:next.rules === undefined ? {} : next.rules,preferences:next.preferences === undefined ? {} : next.preferences});return {...next,rules:document.sites,preferences:document.preferences,missing:Array.isArray(next.missing)?next.missing:[],loading:false,settingsCompatible:next.settingsVersion===SETTINGS_VERSION && complete};}
function draw(){
  const connected=canEdit();
  $("#site-count").textContent=state.loading ? "" : `(${Object.keys(state.rules).length})`;
  $("#connection-status").textContent=state.loading ? "Checking Browser Bridge…" : !state.settingsCompatible || reloadNeeded ? reloadMessage : connected ? "Connected · shared file synced" : state.connected ? (state.lastError || "Shared policy unavailable. Fix the file, then reconnect.") : "Connect to edit the shared policy.";
  $("#connect").hidden=state.loading || !state.settingsCompatible || state.connected;
  $("#policy-path").textContent=state.policy?.path || "Connect to locate your shared file.";
  $("#show-cursor").checked=state.preferences.showCursor;$("#background").checked=state.preferences.background;
  for(const node of document.querySelectorAll('#rule-form button,#suggestions button,#show-cursor,#background'))node.disabled=!connected;
  $("#import").disabled=!canRestore();
  $("#apply-policy").disabled=!canRestore();
  $("#export").disabled=!state.settingsCompatible || !state.policy?.policy;
  const query=$("#find-site").value.toLowerCase(),box=$("#rules");box.replaceChildren();
  for(const [origin,mode] of Object.entries(state.rules).sort()){
    if(!origin.toLowerCase().includes(query))continue;
    const row=element("div",undefined,"site-row");row.dataset.origin=origin;
    row.append(element("span",origin,"site-origin"));
    const controls=element("div",undefined,"site-controls"),select=element("select");select.setAttribute("aria-label",`Access for ${origin}`);
    for(const [value,name] of Object.entries(names)){const o=element("option",name);o.value=value;select.append(o);}select.value=mode;select.disabled=!connected;
    select.addEventListener("change",()=>task(async()=>{const rule=SitePolicy.entry(origin,select.value);await granting(rule);await send({type:"setRule",origin,mode:rule.mode});saved(`${origin}: ${names[rule.mode]}`);}));
    controls.append(select);row.append(controls);
    const remove=element("button","Remove","danger");remove.disabled=!connected;remove.setAttribute("aria-label",`Remove ${origin}`);
    remove.addEventListener("click",()=>task(async()=>{await send({type:"removeRule",origin});removed={origin,mode};$("#undo-message").textContent=`Removed ${origin}.`;$("#undo-box").hidden=false;saved("Site removed.");}));row.append(remove);
    if(mode!=="block" && state.missing.includes(origin)){
      const consent=element("div",undefined,"needs-consent");consent.append(element("span","Browser consent needed","consent"));
      const grant=element("button","Grant access","secondary");grant.addEventListener("click",()=>task(async()=>{await granting(SitePolicy.entry(origin,mode));saved(`Browser access granted: ${origin}`);}));consent.append(grant);row.append(consent);
    }
    box.append(row);
  }
  if(!box.children.length)box.append(element("p",state.loading ? "Loading saved sites…" : query ? "No matching sites." : !state.settingsCompatible ? "Reload Browser Bridge to see your saved sites." : "No saved sites. Add a website to begin.","hint"));
  for(const button of $("#suggestions").children){const exists=Object.hasOwn(state.rules,button.dataset.origin);button.disabled=!connected || exists;button.textContent=button.dataset.label+(exists ? " ✓" : " +");}
}
async function refresh(force=false){try{const next=normalize(await send({type:"rules"}));renderApproval(next);state=next;const key=JSON.stringify([state.rules,state.preferences,state.missing,state.connected,state.policyReady,state.policy?.path,state.settingsCompatible,state.lastError]);if(force || key!==signature){draw();signature=key;}if(refreshError && $("#error").textContent===refreshError)error("");refreshError="";}catch(e){state={...state,settingsCompatible:false,loading:false};signature="";for(const node of document.querySelectorAll('#rule-form button,#suggestions button,#show-cursor,#background,#import,#export,#rules button,#rules select'))node.disabled=true;$("#connection-status").textContent="Settings could not be refreshed. Reconnect Browser Bridge and inspect your saved sites.";refreshError=e.message;error(e.message);throw e;}}
for(const suggestion of SitePolicy.suggestions){
  const label=suggestion.name+(suggestion.mode==="ask" ? " · Ask" : ""),button=element("button",label+" +","secondary");button.dataset.origin=suggestion.origin;button.dataset.label=label;
  button.addEventListener("click",()=>task(async()=>{const rule=SitePolicy.entry(suggestion.origin,suggestion.mode);await granting(rule);await send({type:"setRule",origin:rule.origin,mode:rule.mode});saved(`Added ${rule.origin}: ${names[rule.mode]}`);}));$("#suggestions").append(button);
}
$("#mode").addEventListener("change",()=>{$("#mode-help").textContent=explanations[$("#mode").value];});
$("#rule-form").addEventListener("submit",event=>{event.preventDefault();void task(async()=>{if(reloadNeeded)throw new Error("Reload this extension from your browser’s Extensions page to activate site permissions.");const rule=SitePolicy.website($("#origin").value,$("#mode").value);await granting(rule);await send({type:"setRule",origin:rule.origin,mode:rule.mode});saved(`Saved. ${rule.origin}: ${names[rule.mode]}`);});});
$("#find-site").addEventListener("input",draw);
$("#undo").addEventListener("click",()=>task(async()=>{if(!removed)return;const rule=SitePolicy.entry(removed.origin,removed.mode);await granting(rule);await send({type:"setRule",origin:rule.origin,mode:rule.mode});removed=null;$("#undo-box").hidden=true;saved("Site restored.");}));
$("#connect").addEventListener("click",()=>task(async()=>{await send({type:"connect"});}));
for(const [id,key] of [["#show-cursor","showCursor"],["#background","background"]])$(id).addEventListener("change",()=>task(async()=>{await send({type:"preferences",preferences:{...state.preferences,[key]:$(id).checked}});saved("Preferences saved.");}));
$("#policy-link").addEventListener("click",()=>{$("#policy-heading").focus();});
$("#export").addEventListener("click",()=>{if(!state.policy?.policy)return;const link=element("a");link.href=URL.createObjectURL(new Blob([JSON.stringify(state.policy.policy,null,2)+"\n"],{type:"application/json"}));link.download="browser-policy.json";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);});
$("#import").addEventListener("click",()=>$("#policy-file").click());
$("#policy-file").addEventListener("change",()=>task(async()=>{const file=$("#policy-file").files[0];$("#policy-file").value="";if(!file)return;if(file.size>65536)throw new Error("Policy exceeds 64 KB");imported=SitePolicy.document(JSON.parse(await file.text()));importRevision=taskRevision;const before=state.rules,after=imported.sites;const added=Object.keys(after).filter(o=>!Object.hasOwn(before,o)),changed=Object.keys(after).filter(o=>Object.hasOwn(before,o)&&before[o]!==after[o]),removed=Object.keys(before).filter(o=>!Object.hasOwn(after,o));$("#import-counts").textContent=`${added.length} added · ${changed.length} changed · ${removed.length} removed`;$("#import-sites").textContent=Object.entries(after).sort().map(([o,m])=>`${o} — ${names[m]}`).join("\n") || "All sites will be blocked.";$("#import-preview").showModal();}));
$("#cancel-import").addEventListener("click",()=>{$("#import-preview").close();imported=null;});
$("#apply-policy").addEventListener("click",()=>task(async()=>{if(!imported)return;requireEditable("replacePolicy");const patterns=[...new Set(Object.entries(imported.sites).filter(([,m])=>m!=="block").map(([o,m])=>SitePolicy.entry(o,m).pattern))];if(patterns.length && !await chrome.permissions.request({origins:patterns}))throw new Error("Browser permission was declined; policy was not imported");await send({type:"replacePolicy",document:imported,revision:importRevision});$("#import-preview").close();imported=null;saved("Policy imported.");}));
draw();
if(reloadNeeded){error("Reload this extension from your browser’s Extensions page to activate site permissions. Your browser is still using the older manifest.");}
else {void refresh(true).catch(e=>error(e.message));setInterval(()=>{if(!busy)void refresh().catch(e=>error(e.message));},800);}
