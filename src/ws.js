// ws.js — a minimal WebSocket server built on Node's raw `net`/`crypto`
// APIs. No `ws` npm package: this hand-rolls the RFC6455 handshake and
// frame format (text frames only, no fragmentation/ping-pong beyond what
// real-time chat needs) so real-time messaging works with zero
// dependencies, same philosophy as the rest of this backend.

const crypto = require("crypto");

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const sockets = new Map(); // userId -> Set<net.Socket>

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
}

function encodeFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Decodes exactly one client->server frame (always masked per spec).
// Returns { text, rest } or null if the buffer doesn't yet contain a full frame.
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  if (opcode === 0x8) return { close: true, rest: buf.slice(2) }; // close frame
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = 4;
  if (buf.length < offset + maskLen + len) return null;
  const mask = buf.slice(offset, offset + maskLen);
  const dataStart = offset + maskLen;
  const data = Buffer.alloc(len);
  for (let i = 0; i < len; i++) data[i] = buf[dataStart + i] ^ mask[i % 4];
  return { text: data.toString("utf8"), rest: buf.slice(dataStart + len) };
}

function register(userId, socket) {
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(socket);
  socket.on("close", () => {
    sockets.get(userId)?.delete(socket);
  });
}

function sendToUser(userId, obj) {
  const set = sockets.get(userId);
  if (!set) return;
  const frame = encodeFrame(obj);
  for (const socket of set) {
    if (!socket.destroyed) socket.write(frame);
  }
}

// Called from the HTTP server's `upgrade` event.
function handleUpgrade(req, socket, verify) {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();

  const url = new URL(req.url, "http://placeholder");
  const token = url.searchParams.get("token");
  const auth = verify(token);
  if (!auth) return socket.destroy();

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );

  register(auth.sub, socket);

  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let frame;
    while ((frame = decodeFrame(buffer))) {
      if (frame.close) {
        socket.end();
        return;
      }
      buffer = frame.rest;
      // Clients only need to receive in this app (server pushes new
      // messages); incoming text frames are ignored except as a
      // keepalive/no-op.
    }
  });
  socket.on("error", () => {});
}

module.exports = { handleUpgrade, sendToUser };
