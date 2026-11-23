/**
 * WS <-> TCP bridge for Syncplay.
 * Browser connects to: ws://127.0.0.1:8998/bridge?host=syncplay.pl&port=8995
 * Bridge opens a TCP connection to the Syncplay server and forwards JSON lines
 * in both directions unchanged.
 */
import net from "node:net";
import http from "node:http";
import { WebSocketServer } from "ws";

const LISTEN_PORT = Number(process.env.PORT || 8998);
const DEFAULT_HOST = process.env.SYNCPLAY_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.SYNCPLAY_PORT || 8999);
const ALLOW_ANY_TARGET = process.env.ALLOW_ANY_TARGET === "1";

function safeTarget(url) {
  const host = url.searchParams.get("host") || DEFAULT_HOST;
  const port = Number(url.searchParams.get("port") || DEFAULT_PORT);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!ALLOW_ANY_TARGET) {
    // Default: only allow localhost targets unless explicitly enabled.
    const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!local) return null;
  }
  return { host, port };
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });
let connSeq = 0;

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/bridge") {
    socket.destroy();
    return;
  }
  const target = safeTarget(url);
  if (!target) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, target);
  });
});

wss.on("connection", (ws, _req, target) => {
  const cid = ++connSeq;
  const tcp = net.createConnection({ host: target.host, port: target.port });
  let closed = false;
  let buffer = "";

  const closeAll = () => {
    if (closed) return;
    closed = true;
    try { tcp.destroy(); } catch {}
    try { ws.close(); } catch {}
  };

  tcp.on("connect", () => {
    ws.send(JSON.stringify({ type: "bridge", event: "connected", target }));
  });

  tcp.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      console.log(`[c${cid}] TCP->WS`, line.slice(0,300));
      if (ws.readyState === ws.OPEN) ws.send(line);
    }
  });

  tcp.on("error", (err) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "bridge", event: "tcp-error", message: err.message }));
    }
    closeAll();
  });

  tcp.on("close", () => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "bridge", event: "tcp-close" }));
    }
    closeAll();
  });

  ws.on("message", (data) => {
    const msg = data.toString("utf8");
    let line = msg;
    try {
      const parsed = JSON.parse(msg);
      if (parsed && parsed.type === "bridge" && typeof parsed.line === "string") line = parsed.line;
    } catch {}
    if (!line.endsWith("\n")) line += "\r\n";
    else if (!line.endsWith("\r\n")) line = line.replace(/\n$/, "\r\n");
    console.log(`[c${cid}] WS->TCP`, line.slice(0,300));
    tcp.write(line, "utf8");
  });

  ws.on("close", closeAll);
  ws.on("error", closeAll);
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`Syncplay WS bridge listening on ws://127.0.0.1:${LISTEN_PORT}/bridge`);
  console.log(`Default target ${DEFAULT_HOST}:${DEFAULT_PORT} (ALLOW_ANY_TARGET=${ALLOW_ANY_TARGET})`);
});
