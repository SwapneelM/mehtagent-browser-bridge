let connected = false;
let busy = false;
const toggle = document.querySelector("#toggle");

function render(state) {
  connected = state.connected;
  renderApproval(state);
  document.querySelector("#status").textContent = connected ? "Connected to your assistant" : state.connecting ? "Connecting…" : "Disconnected";
  document.querySelector("#session").textContent = state.connectionId || "—";
  document.querySelector("#action").textContent = state.lastAction || "—";
  document.querySelector("#error").textContent = state.lastError || "";
  toggle.textContent = connected || state.connecting ? "Disconnect" : "Connect";
  toggle.classList.toggle("disconnect", connected || state.connecting);
  toggle.disabled = busy;
}

async function update(type = "status") {
  try { render(await chrome.runtime.sendMessage({ type })); }
  catch (error) { document.querySelector("#error").textContent = error.message; }
}

toggle.addEventListener("click", async () => {
  busy = true;
  toggle.disabled = true;
  const state = await chrome.runtime.sendMessage({ type: "status" });
  await update(state.connected || state.connecting ? "disconnect" : "connect");
  busy = false;
  await update();
});
void update();
setInterval(() => { if (!busy) void update(); }, 600);

document.querySelector("#settings").addEventListener("click",()=>chrome.runtime.openOptionsPage());
