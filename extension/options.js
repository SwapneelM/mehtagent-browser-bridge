const names={allow:"Allow",ask:"Ask every command",block:"Block"};
const currentManifest=chrome.runtime.getManifest();
const reloadNeeded=!currentManifest.permissions?.includes("scripting") || !currentManifest.optional_host_permissions;
if(reloadNeeded) {
  document.querySelector("#error").textContent="Reload this extension from your browser’s Extensions page to activate site permissions. Your browser is still using the older manifest.";
  document.querySelector('button[type="submit"]').disabled=true;
}
const origin=document.querySelector("#origin"), mode=document.querySelector("#mode");
async function renderRules() {
  const state=await chrome.runtime.sendMessage({type:"rules"}), box=document.querySelector("#rules");
  box.replaceChildren();
  if(!Object.keys(state.rules).length) { box.textContent="No sites granted. Add a website to begin."; return; }
  for(const [host,value] of Object.entries(state.rules).sort()) {
    const button=document.createElement("button");button.className="rule";
    const label=document.createElement("span");label.textContent=host;
    const access=document.createElement("span");access.className="mode";access.textContent=names[value];
    button.append(label,access);button.addEventListener("click",()=>{origin.value=host;mode.value=value;origin.focus();});box.append(button);
  }
}
document.querySelector("#rule-form").addEventListener("submit", async event=>{
  event.preventDefault();if(reloadNeeded) return;document.querySelector("#error").textContent="";document.querySelector("#saved").textContent="";
  try {
    const rule=SitePolicy.entry(origin.value,mode.value);
    // Call request directly in this user gesture, before any async work.
    if(rule.mode!=="block" && !await chrome.permissions.request({origins:[rule.pattern]})) throw new Error("Browser permission was declined; site stays blocked");
    const result=await chrome.runtime.sendMessage({type:"setRule",origin:rule.origin,mode:rule.mode});
    if(result.error) throw new Error(result.error);
    await renderRules();document.querySelector("#saved").textContent="Saved. " + rule.origin + ": " + names[rule.mode];
  } catch(error) { document.querySelector("#error").textContent=error.message; }
});
if(!reloadNeeded) void renderRules();
setInterval(async()=>renderApproval(await chrome.runtime.sendMessage({type:"status"})),500);
