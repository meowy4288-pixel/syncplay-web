/**
 * SyncPlay Lite content script. Runs in every frame of every page.
 *
 * Responsibilities:
 *  - find the page's <video>, re-attach when a site replaces it (MutationObserver)
 *  - report local play/pause/seek with an estimated serverTime
 *  - apply remote commands behind the `IsRemote` guard so nothing echoes back
 *  - show a tiny "click to sync" prompt if play() is blocked by autoplay policy
 */
(function () {
  "use strict";

  const P = globalThis.SyncPlayProtocol || {};
  const CONTENT_TO_BG = P.CONTENT_TO_BG || "syncplay:content-to-bg";
  const BG_TO_CONTENT = P.BG_TO_CONTENT || "syncplay:bg-to-content";
  const REGISTER = P.REGISTER || "register";
  const UNREGISTER = P.UNREGISTER || "unregister";
  const LOCAL_EVENT = P.LOCAL_EVENT || "local-event";
  const STATUS = P.STATUS || "status";
  const PLAYBACK = P.PLAYBACK || "playback";
  const CLOCK = P.CLOCK || "clock";
  const APPLY = P.APPLY || "apply";
  const RATE = P.RATE || "rate";
  const GET_PLAYBACK = P.GET_PLAYBACK || "get-playback";

  const api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime) return;

  const token = Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
  const EVENTS = ["play", "pause", "seeked"];
  const GUARD_MS = 1500;

  let video = null;
  let IsRemote = false; // remote-change guard: suppresses echo events
  let guardTimer = null;
  let clockOffset = 0;
  let statusTimer = null;
  let registerTimer = null;
  let attachQueued = false;

  function sendBg(action, extra = {}) {
    try {
      api.runtime.sendMessage({ type: CONTENT_TO_BG, action, token, ...extra });
    } catch (_) {
      /* extension context gone */
    }
  }

  function findVideo() {
    const all = Array.from(document.querySelectorAll("video"));
    if (!all.length) return null;
    return (
      all.find((v) => v.readyState >= 2 && !v.paused) ||
      all.find((v) => v.readyState >= 2) ||
      all[0]
    );
  }

  function onLocalMediaEvent(event) {
    if (IsRemote || !video || event.target !== video) return;
    const type = event.type === "play" ? "play" : event.type === "pause" ? "pause" : "seek";
    sendBg(LOCAL_EVENT, {
      eventType: type,
      position: video.currentTime,
      paused: video.paused,
      serverTime: Date.now() + clockOffset,
    });
  }

  function detach() {
    if (!video) return;
    for (const name of EVENTS) video.removeEventListener(name, onLocalMediaEvent, true);
    video = null;
    clearInterval(statusTimer);
    statusTimer = null;
  }

  function attachIfChanged() {
    const found = findVideo();
    if (found === video) return;
    detach();
    if (!found) {
      sendBg(UNREGISTER);
      return;
    }
    video = found;
    for (const name of EVENTS) video.addEventListener(name, onLocalMediaEvent, true);

    clearInterval(statusTimer);
    statusTimer = setInterval(() => {
      if (!video) return;
      sendBg(STATUS, { position: video.currentTime, paused: video.paused });
    }, 2000);

    sendBg(REGISTER, { hasVideo: true });
  }

  function showAutoplayPrompt() {
    const existing = document.getElementById("syncplay-autoplay-prompt");
    if (existing) return;

    const host = document.createElement("div");
    host.id = "syncplay-autoplay-prompt";
    host.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;" +
      "font:14px system-ui,sans-serif;";

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent =
      "button{cursor:pointer;border:0;border-radius:999px;padding:10px 16px;" +
      "background:#1f6feb;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.4);" +
      "font:600 14px system-ui,sans-serif}";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "▶ Click to sync";
    button.addEventListener("click", async () => {
      if (!video) return;
      try {
        await video.play();
        host.remove();
      } catch (_) {
        button.textContent = "Still blocked — click again";
      }
    });
    shadow.append(style, button);
    (document.body || document.documentElement).appendChild(host);
  }

  function applyRemote(message) {
    if (!video) return;
    IsRemote = true;
    clearTimeout(guardTimer);

    try {
      const target = Number(message.position);
      if (Number.isFinite(target) && (message.force || Math.abs(video.currentTime - target) > 0.05)) {
        video.currentTime = target;
      }
      if (message.paused) {
        if (!video.paused) video.pause();
      } else {
        const result = video.play();
        if (result && typeof result.catch === "function") {
          result.catch((err) => {
            if (err && err.name === "NotAllowedError") showAutoplayPrompt();
          });
        }
      }
    } finally {
      guardTimer = setTimeout(() => {
        IsRemote = false;
      }, GUARD_MS);
    }
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== BG_TO_CONTENT) return false;
    if (message.target && message.target !== "*" && message.target !== token) return false;

    switch (message.action) {
      case CLOCK:
        clockOffset = Number(message.offset) || 0;
        break;

      case APPLY:
        applyRemote(message);
        break;

      case RATE: {
        if (!video) break;
        const rate = Number(message.rate);
        if (Number.isFinite(rate) && rate > 0 && rate <= 4) video.playbackRate = rate;
        break;
      }

      case GET_PLAYBACK:
        sendResponse({
          type: PLAYBACK,
          position: video ? video.currentTime : 0,
          paused: video ? video.paused : true,
          duration: video ? (Number.isFinite(video.duration) ? video.duration : 0) : 0,
          name: (document.title || location.href || "browser-video").slice(0, 200),
          hasVideo: Boolean(video),
        });
        break;

      default:
        break;
    }
    return false;
  });

  // Sites routinely destroy and recreate <video> (SPA navigation, ad roll,
  // switching quality). Re-scan on DOM changes with a debounce.
  const observer = new MutationObserver(() => {
    if (attachQueued) return;
    attachQueued = true;
    setTimeout(() => {
      attachQueued = false;
      attachIfChanged();
    }, 120);
  });
  observer.observe(document.documentElement || document, { childList: true, subtree: true });

  attachIfChanged();

  // Refreshes the background's frame registry after a service-worker/event-page restart.
  registerTimer = setInterval(() => {
    sendBg(REGISTER, { hasVideo: Boolean(video) });
  }, 10000);

  window.addEventListener("pagehide", () => sendBg(UNREGISTER));
})();
