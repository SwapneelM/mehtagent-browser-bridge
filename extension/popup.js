let connected = false;
let busy = false;
let uiError = "";
const manifest = chrome.runtime.getManifest();
const reloadNeeded = !manifest.permissions?.includes("scripting") || !manifest.optional_host_permissions;
const toggle = document.querySelector("#toggle");

function render(state) {
  connected = state.connected;
  renderApproval(state);
  document.querySelector("#status").textContent = connected ? "Connected to your assistant" : state.connecting ? "Connecting…" : "Disconnected";
  document.querySelector("#session").textContent = state.connectionId || "—";
  document.querySelector("#action").textContent = state.lastAction || "—";
  document.querySelector("#error").textContent = uiError || (reloadNeeded ? "Reload this extension from your browser’s Extensions page to activate site permissions. The browser is still using its older manifest." : state.lastError || "");
  toggle.textContent = connected || state.connecting ? "Disconnect" : "Connect";
  toggle.classList.toggle("disconnect", connected || state.connecting);
  toggle.disabled = busy || (reloadNeeded && !state.connected && !state.connecting);
}

async function update(type = "status") {
  try { render(await chrome.runtime.sendMessage({ type })); }
  catch (error) { document.querySelector("#error").textContent = error.message; }
}

toggle.addEventListener("click", async () => {
  busy = true;
  toggle.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: "status" });
    if (reloadNeeded && !state.connected && !state.connecting) return;
    await update(state.connected || state.connecting ? "disconnect" : "connect");
  } catch (error) { uiError = error.message; }
  finally { busy = false; await update(); }
});
void update();
setInterval(() => { if (!busy) void update(); }, 600);

document.querySelector("#settings").addEventListener("click", async () => {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
    uiError = "";
  } catch (error) { uiError = "Could not open Site permissions: " + error.message; }
  await update();
});
