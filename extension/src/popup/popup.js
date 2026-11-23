(function () {
  "use strict";
  const P = globalThis.SyncPlayProtocol || {};
  const POPUP_TO_BG = P.POPUP_TO_BG || "syncplay:popup-to-bg";
  const BG_TO_POPUP = P.BG_TO_POPUP || "syncplay:bg-to-popup";
  const api = globalThis.browser || globalThis.chrome;
  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status"), bridgeUrl: $("bridgeUrl"), serverHost: $("serverHost"), serverPort: $("serverPort"),
    room: $("room"), user: $("user"), password: $("password"),
    connect: $("connect"), disconnect: $("disconnect"), resync: $("resync"), ready: $("ready"),
    leaderClaim: $("leaderClaim"), leaderPass: $("leaderPass"), leaderRelease: $("leaderRelease"), leaderInfo: $("leaderInfo"),
    users: $("users"), roomInfo: $("roomInfo"), diagnostics: $("diagnostics"), error: $("error"),
  };
  let lastErrorMsg = "";

  function toBg(action, extra = {}) {
    return api.runtime.sendMessage({ type: POPUP_TO_BG, action, ...extra });
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  function render(state) {
    if (!state) return;
    const online = !!state.connected;
    const connecting = !online && !!state.bridgeConnected;
    els.status.textContent = online ? "connected" : (connecting ? "connecting" : "disconnected");
    els.status.classList.toggle("online", online);
    els.status.classList.toggle("connecting", connecting);

    const s = state.settings || {};
    if (document.activeElement !== els.bridgeUrl) els.bridgeUrl.value = s.bridgeUrl || "";
    if (document.activeElement !== els.serverHost) els.serverHost.value = s.serverHost || "";
    if (document.activeElement !== els.serverPort) els.serverPort.value = s.serverPort || 8999;
    if (document.activeElement !== els.room) els.room.value = s.room || state.room || "";
    if (document.activeElement !== els.user) els.user.value = s.user || state.user || "";
    if (document.activeElement !== els.password && s.password !== "***") els.password.value = s.password || "";

    els.connect.disabled = online;
    els.disconnect.disabled = !online && !state.bridgeConnected;
    els.resync.disabled = !online;
    els.ready.disabled = !online;

    els.roomInfo.textContent = state.room ? `${state.room} · ${(state.users||[]).length} users` : "—";
    els.users.replaceChildren();
    const users = state.users || [];
    if (!users.length) {
      const li = document.createElement("li"); li.className = "muted"; li.textContent = online ? "Only you" : "No one yet";
      els.users.appendChild(li);
    } else {
      for (const u of users) {
        const li = document.createElement("li");
        const bits = [u.name];
        if (state.leader && u.name === state.leader) bits.push("[leader]");
        if (u.name === state.user) bits.push("[you]");
        if (u.isReady === true) bits.push("[ready]");
        if (u.isReady === false) bits.push("[not ready]");
        if (u.controller) bits.push("[controller]");
        li.textContent = bits.join(" ");
        els.users.appendChild(li);
      }
    }

    const g = state.global || {position:0, paused:true};
    const leader = state.leader || null;
    const isLeader = leader && leader === state.user;
    els.leaderInfo.textContent = leader ? `Leader: ${leader}${isLeader ? " (you)" : ""}` : "Leader: none (anyone can drive)";
    els.leaderClaim.disabled = !online || isLeader;
    els.leaderPass.disabled = !online || !isLeader;
    els.leaderRelease.disabled = !online || !isLeader;
    els.diagnostics.textContent = online
      ? `${fmtTime(g.position)} · ${g.paused ? "paused" : "playing"} · ${state.activeFrame ? "video attached" : "no video detected"} · ${isLeader ? "you are leader" : (leader ? "following leader" : "no leader")}`
      : "Connect through the WS bridge to a Syncplay server.";
    const err = state.lastError || lastErrorMsg;
    if (err) { els.error.hidden = false; els.error.textContent = err; }
    else { els.error.hidden = true; els.error.textContent = ""; }
  }

  function configFromInputs() {
    return {
      bridgeUrl: els.bridgeUrl.value.trim(),
      serverHost: els.serverHost.value.trim(),
      serverPort: Number(els.serverPort.value) || 8999,
      room: els.room.value.trim() || "default",
      user: els.user.value.trim() || "web-user",
      password: els.password.value,
    };
  }

  async function refresh() {
    try { render(await toBg("get-state")); } catch { els.status.textContent = "unavailable"; }
  }

  function saveConfig() { toBg("set-config", { config: configFromInputs() }).then(render).catch(()=>{}); }
  [els.bridgeUrl, els.serverHost, els.serverPort, els.room, els.user, els.password].forEach(i => {
    i.addEventListener("change", saveConfig); i.addEventListener("blur", saveConfig);
  });

  els.connect.addEventListener("click", async () => { lastErrorMsg = ""; saveConfig(); render(await toBg("connect", { config: configFromInputs() }).catch(()=>null)); refresh(); });
  els.disconnect.addEventListener("click", async () => { lastErrorMsg = ""; await toBg("disconnect").catch(()=>{}); refresh(); });
  els.resync.addEventListener("click", async () => { await toBg("resync").catch(()=>{}); });
  els.ready.addEventListener("click", async () => {
    const st = await toBg("get-state").catch(()=>null);
    const me = (st?.users||[]).find(u => u.name === st.user);
    await toBg("ready", { isReady: !(me && me.isReady) }).catch(()=>{});
    refresh();
  });
  els.leaderClaim.addEventListener("click", async () => { await toBg("leader-claim").catch(()=>{}); refresh(); });
  els.leaderRelease.addEventListener("click", async () => { await toBg("leader-release").catch(()=>{}); refresh(); });
  els.leaderPass.addEventListener("click", async () => {
    const st = await toBg("get-state").catch(()=>null);
    const others = (st?.users||[]).map(u=>u.name).filter(n=>n && n !== st.user);
    const target = prompt("Pass leader to username:", others[0] || "");
    if (target) await toBg("leader-pass", { target: target.trim() }).catch(()=>{});
    refresh();
  });

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== BG_TO_POPUP) return;
    if (msg.action === "state") { if (msg.state && msg.state.lastError) lastErrorMsg = ""; render(msg.state); }
    if (msg.action === "error") { lastErrorMsg = msg.message || "Error"; els.error.hidden = false; els.error.textContent = lastErrorMsg; }
  });
  refresh(); setInterval(refresh, 1500);
})();
