/**
 * Message names shared by the content script and popup.
 * The background is self-contained (classic script / service worker) and uses
 * the same string literals; keep both files in sync when changing the protocol.
 */
(function (root) {
  "use strict";

  const protocol = {
    // runtime messages
    CONTENT_TO_BG: "syncplay:content-to-bg",
    BG_TO_CONTENT: "syncplay:bg-to-content",
    POPUP_TO_BG: "syncplay:popup-to-bg",
    BG_TO_POPUP: "syncplay:bg-to-popup",

    // content -> background
    REGISTER: "register",
    UNREGISTER: "unregister",
    LOCAL_EVENT: "local-event",
    STATUS: "status",
    PLAYBACK: "playback",

    // background -> content
    CLOCK: "clock",
    APPLY: "apply",
    RATE: "rate",
    GET_PLAYBACK: "get-playback",

    // popup -> background
    GET_STATE: "get-state",
    CONNECT: "connect",
    DISCONNECT: "disconnect",
    RESYNC: "resync",
    SET_CONFIG: "set-config",

    // WebSocket wire types (client -> server / server -> client)
    WS_JOIN: "join",
    WS_EVENT: "event",
    WS_PING: "ping",
    WS_LEAVE: "leave",
    WS_WELCOME: "welcome",
    WS_USERS: "users",
    WS_PONG: "pong",
    WS_ERROR: "error",

    HARD_SEEK_DRIFT: 1.0, // seconds
    SOFT_RATE_DRIFT: 0.15, // seconds
    HEARTBEAT_MS: 3000,
  };

  root.SyncPlayProtocol = protocol;
})(typeof globalThis !== "undefined" ? globalThis : window);
