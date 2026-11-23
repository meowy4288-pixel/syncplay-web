/**
 * Syncplay Web background (MV3 service worker / Firefox background script).
 * Speaks Syncplay line-delimited JSON protocol over a WS<->TCP bridge.
 */
(function () {
  "use strict";

  const P = globalThis.SyncPlayProtocol || {};
  const CONTENT_TO_BG = P.CONTENT_TO_BG || "syncplay:content-to-bg";
  const BG_TO_CONTENT = P.BG_TO_CONTENT || "syncplay:bg-to-content";
  const POPUP_TO_BG = P.POPUP_TO_BG || "syncplay:popup-to-bg";
  const BG_TO_POPUP = P.BG_TO_POPUP || "syncplay:bg-to-popup";

  const api = globalThis.browser || globalThis.chrome;
  const VERSION = "1.2.255";
  const REAL_VERSION = "1.7.0";
  const PING_MOVING_AVERAGE_WEIGHT = 0.85;
  const STATE_INTERVAL_MS = 1000;
  const HARD_SEEK_DRIFT = 1.0;
  const SOFT_RATE_DRIFT = 0.15;

  const DEFAULT_SETTINGS = {
    bridgeUrl: "ws://127.0.0.1:8998/bridge",
    serverHost: "127.0.0.1",
    serverPort: 8999,
    room: "default",
    user: "web-" + Math.floor(Math.random() * 10000),
    password: "",
    wantConnected: false,
  };

  let settings = { ...DEFAULT_SETTINGS };
  let ws = null;
  let connected = false; // bridge connected
  let logged = false;    // Syncplay hello completed
  let reconnectTimer = null;
  let stateTimer = null;
  let lastStateSentAt = 0;
  let leaderAnnounceTicks = 0;

  // Syncplay ping service
  let rtt = 0;
  let avrRtt = 0;
  let fd = 0; // forward delay estimate
  let lastLatencyCalculation = 0;
  let lastLatencyArrival = 0;

  // ignore counters
  let clientIgnoringOnTheFly = 0;
  let serverIgnoringOnTheFly = 0;
  let hadFirstState = false;

  // room state
  let globalPosition = 0;
  let globalPaused = true;
  let lastGlobalUpdate = 0;
  let lastReportedLocalPos = null;
  let lastReportedLocalAt = 0;
  let users = {}; // room -> {username: {file, controller, isReady, features}}
  let roomName = settings.room;
  let leader = null; // username of current leader

  // local playback (from active frame)
  const frames = new Map(); // tabId:frameToken -> {tabId, frameToken, hasVideo, position, paused, lastSeen}
  let activeFrame = null; // {tabId, frameToken}
  let initPromise = Promise.resolve();

  function key(tabId, frameToken) { return tabId + ":" + frameToken; }
  function now() { return Date.now() / 1000; }

  function debug(msg) { try { console.debug("[syncplay-web]", msg); } catch {} }

  function saveSettings() { try { api.storage.local.set({ settings }); } catch {} }
  async function loadSettings() {
    try {
      const got = await api.storage.local.get("settings");
      if (got && got.settings) settings = { ...DEFAULT_SETTINGS, ...got.settings };
    } catch {}
  }

  function getGlobalPosition() {
    if (!lastGlobalUpdate) return 0;
    let pos = globalPosition;
    if (!globalPaused) pos += now() - lastGlobalUpdate;
    return pos;
  }

  function sendPopup(action, extra = {}) {
    try { api.runtime.sendMessage({ type: BG_TO_POPUP, action, ...extra }); } catch {}
  }

  function broadcastState() {
    sendPopup("state", { state: getPublicState() });
  }

  function getPublicState() {
    const roomUsers = users[roomName] || {};
    return {
      connected: logged,
      bridgeConnected: connected,
      room: roomName,
      user: settings.user,
      leader,
      users: Object.entries(roomUsers).map(([name, u]) => ({
        name, isReady: !!u.isReady, controller: !!u.controller, file: u.file || null,
      })),
      global: { position: getGlobalPosition(), paused: globalPaused },
      settings: { ...settings, password: settings.password ? "***" : "" },
      activeFrame,
    };
  }

  function setBadge(text, color) {
    try { api.action.setBadgeText({ text }); api.action.setBadgeBackgroundColor({ color }); } catch {}
  }

  function wsSend(obj) {
    if (!ws || ws.readyState !== 1) return;
    const line = JSON.stringify(obj);
    ws.send(line);
    debug(">> " + line);
  }

  function sendHello() {
    const hello = {
      username: settings.user,
      room: { name: settings.room },
      version: VERSION,
      realversion: REAL_VERSION,
      features: {
        sharedPlaylists: false,
        chat: false,
        uiMode: "CLI",
        featureList: true,
        readiness: true,
        managedRooms: false,
        persistentRooms: false,
      },
    };
    if (settings.password) hello.password = settings.password;
    wsSend({ Hello: hello });
  }

  function sendList() { wsSend({ List: null }); }

  function sendFile(file) {
    wsSend({ Set: { file } });
  }

  function sendReady(isReady, manuallyInitiated = true) {
    wsSend({ Set: { ready: { isReady, manuallyInitiated } } });
  }

  function sendChat(text) {
    wsSend({ Chat: text });
  }

  function sendLeaderControl(action, target = null) {
    const payload = { type: "sw-leader", action, by: settings.user, target, ts: Date.now() };
    sendChat("__sw__:" + JSON.stringify(payload));
  }

  function isLeader() { return !!leader && leader === settings.user; }

  function setLeader(name, announce = false) {
    leader = name || null;
    if (announce) sendLeaderControl("set", leader);
    broadcastState();
  }

  function sendState(forceStateChange = false, doSeek = null, override = null, latencyCalculationToEcho = null) {
    if (!logged || !ws || ws.readyState !== 1) return;
    let local = override || getLocalPlayback();
    // Followers report global/server state to avoid fighting the leader.
    if (!override && leader && !isLeader()) {
      local = { position: getGlobalPosition(), paused: globalPaused };
    }
    // Heuristic: if local video appears stalled while playing, avoid pulling server back.
    if (!override && local && local.paused === false && !forceStateChange) {
      const gpos = getGlobalPosition();
      const nowSec = now();
      const realPos = local.position;
      if (lastReportedLocalPos !== null && (nowSec - lastReportedLocalAt) >= 1.5) {
        const advanced = Math.abs(realPos - lastReportedLocalPos);
        const behind = gpos - realPos;
        if (advanced < 0.25 && behind > 0.5 && behind < 10) {
          // Stalled: report paused at real position to avoid dragging others.
          local = { position: realPos, paused: true };
        }
      }
      // Track real local position, not the overridden one.
      if (lastReportedLocalPos === null || Math.abs(realPos - lastReportedLocalPos) > 0.1 || (nowSec - lastReportedLocalAt) >= 2) {
        lastReportedLocalPos = realPos;
        lastReportedLocalAt = nowSec;
      }
    } else if (local) {
      lastReportedLocalPos = local.position;
      lastReportedLocalAt = now();
    }
    const state = { ping: {} };

    const hasLocal = local && Number.isFinite(local.position) && typeof local.paused === "boolean";
    const clientIgnoreOk = clientIgnoringOnTheFly === 0 || serverIgnoringOnTheFly !== 0;
    if (clientIgnoreOk && hasLocal) {
      state.playstate = { position: local.position, paused: local.paused };
      if (doSeek !== null) state.playstate.doSeek = doSeek;
    }

    if (latencyCalculationToEcho) {
      state.ping.latencyCalculation = latencyCalculationToEcho;
    }
    state.ping.clientLatencyCalculation = now();
    state.ping.clientRtt = rtt;

    if (forceStateChange) clientIgnoringOnTheFly += 1;
    if (serverIgnoringOnTheFly || clientIgnoringOnTheFly) {
      state.ignoringOnTheFly = {};
      if (serverIgnoringOnTheFly) {
        state.ignoringOnTheFly.server = serverIgnoringOnTheFly;
        serverIgnoringOnTheFly = 0;
      }
      if (clientIgnoringOnTheFly) {
        state.ignoringOnTheFly.client = clientIgnoringOnTheFly;
      }
    }
    wsSend({ State: state });
    lastStateSentAt = Date.now();
  }

  function getLocalPlayback() {
    if (!activeFrame) return null;
    const f = frames.get(key(activeFrame.tabId, activeFrame.frameToken));
    if (!f) return null;
    return { position: f.position, paused: f.paused };
  }

  function pickActiveFrame() {
    let best = null;
    for (const f of frames.values()) {
      if (!f.hasVideo) continue;
      if (!best || f.lastSeen > best.lastSeen) best = f;
    }
    activeFrame = best ? { tabId: best.tabId, frameToken: best.frameToken } : null;
  }

  function sendToFrame(action, extra = {}, target = activeFrame) {
    if (!target) return;
    try {
      api.tabs.sendMessage(target.tabId, {
        type: BG_TO_CONTENT, action, target: target.frameToken, ...extra,
      }).catch(() => {});
    } catch {}
  }

  function applyGlobalToPlayer(doSeek = false) {
    if (!activeFrame) return;
    const pos = getGlobalPosition();
    sendToFrame("apply", { position: pos, paused: globalPaused, force: !!doSeek });
    sendToFrame("clock", { offset: 0 });
    // Update cached local state to avoid echoing stale position back to server.
    const f = frames.get(key(activeFrame.tabId, activeFrame.frameToken));
    if (f) { f.position = pos; f.paused = globalPaused; f.lastSeen = Date.now(); }
  }

  function handleBridgeEvent(msg) {
    if (msg.event === "connected") {
      connected = true;
      setBadge("...", "#f59e0b");
      sendHello();
    } else if (msg.event === "tcp-error" || msg.event === "tcp-close") {
      logged = false;
      connected = false;
      setBadge("!", "#dc2626");
      broadcastState();
      scheduleReconnect();
    }
  }

  function handleSyncplayMessage(msg) {
    if (msg.Hello) return handleHello(msg.Hello);
    if (msg.Set) return handleSet(msg.Set);
    if (msg.List) return handleList(msg.List);
    if (msg.State) return handleState(msg.State);
    if (msg.Error) return handleError(msg.Error);
    if (msg.Chat) {
      const m = msg.Chat;
      const text = typeof m === "string" ? m : (m.message || "");
      const from = typeof m === "object" && m.username ? m.username : null;
      if (text.startsWith("__sw__:")) {
        try {
          const payload = JSON.parse(text.slice(6));
          if (payload && payload.type === "sw-leader") {
            if (payload.action === "set") {
              leader = payload.target || null;
              broadcastState();
            } else if (payload.action === "claim") {
              // last claim wins in this simple MVP
              leader = payload.by || null;
              broadcastState();
            } else if (payload.action === "pass" && payload.target) {
              leader = payload.target;
              broadcastState();
            } else if (payload.action === "release") {
              if (leader === payload.by) { leader = null; broadcastState(); }
            }
          }
        } catch {}
        return;
      }
      return; // ignore normal chat in MVP
    }
    if (msg.TLS) return; // bridge/plain MVP
  }

  function handleHello(hello) {
    if (hello.username) settings.user = hello.username;
    if (hello.room && hello.room.name) roomName = hello.room.name;
    logged = true;
    hadFirstState = false;
    setBadge("ON", "#16a34a");
    saveSettings();
    sendList();
    sendCurrentFile();
    broadcastState();
  }

  function handleSet(set) {
    if (set.room && set.room.name) { roomName = set.room.name; }
    if (set.user) {
      let sawJoin = false;
      for (const [username, u] of Object.entries(set.user)) {
        const r = u.room && u.room.name ? u.room.name : roomName;
        if (!users[r]) users[r] = {};
        if (u.event && u.event.left) {
          delete users[r][username];
          if (leader === username) leader = null;
        } else {
          users[r][username] = { ...(users[r][username] || {}), file: u.file || users[r][username]?.file || null };
          if (u.event && u.event.joined) { users[r][username].isReady = null; sawJoin = true; }
        }
      }
      if (sawJoin && isLeader()) sendLeaderControl("set", leader);
    }
    if (set.ready) {
      const r = roomName;
      if (!users[r]) users[r] = {};
      const name = set.ready.username;
      if (name) {
        if (!users[r][name]) users[r][name] = {};
        users[r][name].isReady = !!set.ready.isReady;
      }
    }
    broadcastState();
  }

  function handleList(list) {
    users = {};
    for (const [r, roomUsers] of Object.entries(list || {})) {
      users[r] = {};
      for (const [uname, u] of Object.entries(roomUsers || {})) {
        users[r][uname] = {
          file: u.file && Object.keys(u.file).length ? u.file : null,
          controller: !!u.controller,
          isReady: u.isReady,
          features: u.features || {},
        };
      }
    }
    broadcastState();
  }

  function handleState(state) {
    if (state.ignoringOnTheFly) {
      const ig = state.ignoringOnTheFly;
      if (ig.server !== undefined) { serverIgnoringOnTheFly = ig.server; clientIgnoringOnTheFly = 0; }
      else if (ig.client !== undefined && ig.client === clientIgnoringOnTheFly) { clientIgnoringOnTheFly = 0; }
    }

    let messageAge = 0;
    let latencyCalculation = null;
    if (state.ping) {
      latencyCalculation = state.ping.latencyCalculation || null;
      if (latencyCalculation) lastLatencyCalculation = latencyCalculation;
      if (state.ping.clientLatencyCalculation) {
        const ts = state.ping.clientLatencyCalculation;
        const newRtt = now() - ts;
        const senderRtt = Number(state.ping.serverRtt) || 0;
        if (newRtt >= 0 && senderRtt >= 0) {
          rtt = newRtt;
          if (!avrRtt) avrRtt = rtt;
          avrRtt = avrRtt * PING_MOVING_AVERAGE_WEIGHT + rtt * (1 - PING_MOVING_AVERAGE_WEIGHT);
          fd = senderRtt < rtt ? avrRtt / 2 + (rtt - senderRtt) : avrRtt / 2;
        }
      }
      messageAge = fd;
    }

    let applied = false;
    if (state.playstate) {
      const p = state.playstate;
      const paused = !!p.paused;
      let position = Number(p.position) || 0;
      if (!paused) position += messageAge;
      const doSeek = !!p.doSeek;

      const diff = Math.abs(getGlobalPosition() - position);
      // Be conservative: avoid seek loops. Explicit seeks or pause changes always apply;
      // while playing only correct large drift.
      const driftThreshold = paused ? 0.8 : 2.0;
      const changed = !hadFirstState || paused !== globalPaused || doSeek || diff > driftThreshold;
      globalPaused = paused;
      globalPosition = position;
      lastGlobalUpdate = now();
      hadFirstState = true;

      if (clientIgnoringOnTheFly === 0 && changed) {
        applyGlobalToPlayer(doSeek);
        applied = true;
      }
    }

    // Respond. Followers should not fight leader/server state; report applied/global state.
    let local;
    if (leader && !isLeader()) {
      local = { position: getGlobalPosition(), paused: globalPaused };
    } else if (applied) {
      local = { position: getGlobalPosition(), paused: globalPaused };
    } else {
      local = getLocalPlayback();
    }
    sendState(false, null, local, latencyCalculation);
    broadcastState();
  }

  function handleError(err) {
    debug("Syncplay error: " + (err.message || JSON.stringify(err)));
    sendPopup("error", { message: err.message || String(err) });
  }

  function connect() {
    try { disconnect(false); } catch {}
    settings.wantConnected = true;
    saveSettings();
    let url;
    try {
      url = new URL(settings.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl);
      url.searchParams.set("host", settings.serverHost || DEFAULT_SETTINGS.serverHost);
      url.searchParams.set("port", String(settings.serverPort || DEFAULT_SETTINGS.serverPort));
    } catch (e) {
      debug("bad bridge url: " + e);
      sendPopup("error", { message: "Bad bridge URL" });
      broadcastState();
      return;
    }
    try {
      ws = new WebSocket(url.toString());
    } catch (e) {
      debug("ws create failed: " + e);
      sendPopup("error", { message: "WebSocket failed: " + e.message });
      scheduleReconnect();
      broadcastState();
      return;
    }
    setBadge("...", "#f59e0b");

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && msg.type === "bridge") return handleBridgeEvent(msg);
      handleSyncplayMessage(msg);
    };
    ws.onclose = () => {
      connected = false; logged = false;
      setBadge("", "#666");
      broadcastState();
      if (settings.wantConnected) scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch {} };

    clearInterval(stateTimer);
    stateTimer = setInterval(() => {
      if (!logged) return;
      sendState(false);
      if (isLeader()) {
        leaderAnnounceTicks = (leaderAnnounceTicks + 1) % 10;
        if (leaderAnnounceTicks === 0) sendLeaderControl("set", leader);
      } else {
        leaderAnnounceTicks = 0;
      }
    }, STATE_INTERVAL_MS);
  }

  function disconnect(userInitiated = true) {
    if (userInitiated) {
      if (isLeader()) { try { sendLeaderControl("release"); } catch {} leader = null; }
      settings.wantConnected = false; saveSettings();
    }
    clearTimeout(reconnectTimer); reconnectTimer = null;
    clearInterval(stateTimer); stateTimer = null;
    if (ws) { try { ws.close(); } catch {} ws = null; }
    connected = false; logged = false; hadFirstState = false;
    clientIgnoringOnTheFly = 0; serverIgnoringOnTheFly = 0;
    setBadge("", "#666");
    broadcastState();
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (!settings.wantConnected) return;
    reconnectTimer = setTimeout(() => { if (settings.wantConnected) connect(); }, 3000);
  }

  async function sendCurrentFile() {
    if (!activeFrame) return;
    const f = frames.get(key(activeFrame.tabId, activeFrame.frameToken));
    if (!f) return;
    try {
      const p = api.tabs.sendMessage(f.tabId, { type: BG_TO_CONTENT, action: "get-playback", target: f.frameToken });
      const resp = (p && typeof p.then === "function") ? await p : await new Promise((resolve) => {
        try { api.tabs.sendMessage(f.tabId, { type: BG_TO_CONTENT, action: "get-playback", target: f.frameToken }, resolve); } catch { resolve(null); }
      });
      const name = (resp && resp.name) ? String(resp.name).slice(0, 200) : "browser-video";
      const duration = resp && Number.isFinite(resp.duration) ? resp.duration : 0;
      sendFile({ name, duration, size: 0 });
    } catch {
      sendFile({ name: "browser-video", duration: 0, size: 0 });
    }
  }

  // --- Content script messages ---
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === CONTENT_TO_BG) {
      const tabId = sender.tab ? sender.tab.id : -1;
      const frameToken = msg.token;
      const k = key(tabId, frameToken);
      if (msg.action === "register") {
        const prev = frames.get(k) || {};
        frames.set(k, { ...prev, tabId, frameToken, hasVideo: !!msg.hasVideo, lastSeen: Date.now() });
        const cur = activeFrame ? frames.get(key(activeFrame.tabId, activeFrame.frameToken)) : null;
        if (!cur || !cur.hasVideo) pickActiveFrame();
        else if (activeFrame.tabId === tabId && activeFrame.frameToken === frameToken) { /* keep */ }
        // don't steal active frame just because another frame re-registered
        if (logged) sendCurrentFile();
        broadcastState();
        return;
      }
      if (msg.action === "unregister") {
        frames.delete(k);
        pickActiveFrame();
        broadcastState();
        return;
      }
      if (msg.action === "status") {
        const f = frames.get(k);
        if (f) { f.position = Number(msg.position) || 0; f.paused = !!msg.paused; f.lastSeen = Date.now(); }
        return;
      }
      if (msg.action === "local-event") {
        const f = frames.get(k);
        if (f) {
          f.position = Number(msg.position) || 0;
          f.paused = !!msg.paused;
          f.lastSeen = Date.now();
        }
        activeFrame = { tabId, frameToken };
        const canDrive = !leader || isLeader();
        if (logged && canDrive) {
          const doSeek = msg.eventType === "seek";
          sendState(true, doSeek, { position: f ? f.position : 0, paused: f ? f.paused : true });
          sendCurrentFile();
        }
        broadcastState();
        return;
      }
      return;
    }

    if (msg.type === POPUP_TO_BG) {
      (async () => {
        await initPromise;
        if (msg.action === "get-state") { sendResponse(getPublicState()); return; }
        if (msg.action === "set-config") {
          settings = { ...settings, ...(msg.config || {}) };
          saveSettings();
          broadcastState();
          sendResponse({ ok: true, state: getPublicState() });
          return;
        }
        if (msg.action === "connect") {
          if (msg.config) settings = { ...settings, ...msg.config };
          connect();
          sendResponse({ ok: true, state: getPublicState() });
          return;
        }
        if (msg.action === "disconnect") { disconnect(true); sendResponse({ ok: true, state: getPublicState() }); return; }
        if (msg.action === "resync") {
          if (logged) { sendState(true, true, getLocalPlayback()); }
          sendResponse({ ok: true });
          return;
        }
        if (msg.action === "ready") {
          if (logged) sendReady(!!msg.isReady, true);
          sendResponse({ ok: true });
          return;
        }
        if (msg.action === "leader-claim") {
          if (logged) { leader = settings.user; sendLeaderControl("claim"); broadcastState(); }
          sendResponse({ ok: true, state: getPublicState() });
          return;
        }
        if (msg.action === "leader-pass") {
          if (logged && isLeader() && msg.target) { leader = msg.target; sendLeaderControl("pass", msg.target); broadcastState(); }
          sendResponse({ ok: true, state: getPublicState() });
          return;
        }
        if (msg.action === "leader-release") {
          if (logged && isLeader()) { leader = null; sendLeaderControl("release"); broadcastState(); }
          sendResponse({ ok: true, state: getPublicState() });
          return;
        }
        sendResponse({ ok: false });
      })();
      return true; // keep sendResponse channel for async
    }
  });

  api.tabs.onRemoved.addListener((tabId) => {
    for (const k of Array.from(frames.keys())) { if (frames.get(k).tabId === tabId) frames.delete(k); }
    pickActiveFrame(); broadcastState();
  });

  // init
  initPromise = (async () => {
    await loadSettings();
    if (settings.wantConnected) connect();
    broadcastState();
  })();
})();
