let approvalId=null;
function renderApproval(state) {
  const pending=state.pendingApproval;
  document.querySelector("#approval").hidden=!pending;
  approvalId=pending?.id || null;
  if(!pending) return;
  document.querySelector("#approval-summary").textContent=`${pending.agent} · ${pending.action} · tab ${pending.tab}`;
  const detail={url:pending.url,command:pending.details,files:pending.files,expires:new Date(pending.expires*1000).toLocaleTimeString()};
  const text=JSON.stringify(detail,null,2), el=document.querySelector("#approval-details");
  if(el.textContent!==text) el.textContent=text;
}
for(const [id,allow] of [["approve",true],["deny",false]]) document.querySelector("#"+id).addEventListener("click",async()=>{
  if(approvalId) renderApproval(await chrome.runtime.sendMessage({type:"approval",id:approvalId,allow}));
});
