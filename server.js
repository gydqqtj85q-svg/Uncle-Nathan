const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.json({ ok: true }));

const rooms = new Map();

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function id() { return crypto.randomUUID(); }
function token() { return crypto.randomBytes(24).toString("hex"); }
function getRoom(c) { return rooms.get(String(c || "").trim().toUpperCase()); }
function byToken(r, t) { return r.players.find(p => p.token === t); }
function alive(r) { return r.players.filter(p => p.alive); }

function publicRoom(r) {
  return {
    code: r.code,
    started: r.started,
    finished: !!r.finished,
    hostId: r.hostPlayerId,
    players: r.players.map(p => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      submitted: !!p.character
    })),
    turnId: r.turnId,
    remainingCharacters: r.started
      ? Object.entries(r.characterCounts).map(([name, count]) => ({ name, count }))
      : [],
    winnerId: r.winnerId || null
  };
}
function emitRoom(r) { io.to(r.code).emit("room_state", publicRoom(r)); }

function attach(socket, r, p) {
  p.socketId = socket.id;
  socket.join(r.code);
  socket.data.room = r.code;
  socket.data.playerToken = p.token;
  socket.data.playerId = p.id;
}
function finishIfNeeded(r) {
  const remaining = alive(r);
  if (r.started && remaining.length === 1) {
    r.finished = true;
    r.winnerId = remaining[0].id;
    r.turnId = null;
  }
}

io.on("connection", socket => {
  socket.on("create_room", async ({ name, playerToken }, cb = () => {}) => {
    const clean = String(name || "").trim().slice(0, 30);
    if (!clean) return cb({ ok: false, error: "NAME_REQUIRED" });

    let c;
    do { c = roomCode(); } while (rooms.has(c));

    const p = {
      id: id(),
      token: playerToken || token(),
      socketId: socket.id,
      name: clean,
      character: "",
      alive: true
    };
    const r = {
      code: c,
      hostPlayerId: p.id,
      players: [p],
      started: false,
      finished: false,
      turnId: null,
      characterCounts: {},
      winnerId: null
    };
    rooms.set(c, r);
    attach(socket, r, p);

    const proto = socket.handshake.headers["x-forwarded-proto"] || socket.handshake.protocol;
    const base = `${proto}://${socket.handshake.headers.host}`;
    const joinUrl = `${base}/?room=${c}`;
    let qr = "";
    try { qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 640 }); } catch (_) {}

    cb({ ok: true, code: c, joinUrl, qr, playerId: p.id, token: p.token });
    emitRoom(r);
  });

  socket.on("join_room", ({ code, name, playerToken }, cb = () => {}) => {
    const r = getRoom(code);
    if (!r) return cb({ ok: false, error: "ROOM_NOT_FOUND" });

    // Rejoin always comes BEFORE "game started" validation.
    if (playerToken) {
      const existing = byToken(r, playerToken);
      if (existing) {
        attach(socket, r, existing);
        cb({
          ok: true, code: r.code, playerId: existing.id,
          token: existing.token, name: existing.name, rejoined: true
        });
        emitRoom(r);
        return;
      }
    }

    if (r.started) return cb({ ok: false, error: "GAME_STARTED" });

    const clean = String(name || "").trim().slice(0, 30);
    if (!clean) return cb({ ok: false, error: "NAME_REQUIRED" });
    if (r.players.some(p => p.name.toLowerCase() === clean.toLowerCase())) {
      return cb({ ok: false, error: "NAME_TAKEN" });
    }

    const p = {
      id: id(),
      token: playerToken || token(),
      socketId: socket.id,
      name: clean,
      character: "",
      alive: true
    };
    r.players.push(p);
    attach(socket, r, p);

    cb({ ok: true, code: r.code, playerId: p.id, token: p.token, name: p.name });
    emitRoom(r);
  });

  socket.on("submit_character", ({ character }, cb = () => {}) => {
    const r = getRoom(socket.data.room);
    if (!r || r.started) return cb({ ok: false, error: "GAME_STARTED" });

    const p = byToken(r, socket.data.playerToken);
    const ch = String(character || "").trim().slice(0, 50);
    if (!p || !ch) return cb({ ok: false, error: "CHARACTER_REQUIRED" });

    p.character = ch;
    cb({ ok: true });
    emitRoom(r);
  });

  socket.on("start_game", (_, cb = () => {}) => {
    const r = getRoom(socket.data.room);
    const p = r && byToken(r, socket.data.playerToken);
    if (!r || !p || r.hostPlayerId !== p.id) return cb({ ok: false, error: "HOST_ONLY" });
    if (r.players.length < 2) return cb({ ok: false, error: "NEED_PLAYERS" });
    if (r.players.some(x => !x.character)) return cb({ ok: false, error: "WAITING_SUBMISSIONS" });

    r.started = true;
    r.finished = false;
    r.winnerId = null;
    r.players.forEach(x => x.alive = true);
    r.characterCounts = {};
    for (const x of r.players) {
      r.characterCounts[x.character] = (r.characterCounts[x.character] || 0) + 1;
    }
    const a = alive(r);
    r.turnId = a[Math.floor(Math.random() * a.length)].id;

    cb({ ok: true });
    emitRoom(r);
  });

  socket.on("guess", ({ targetId, character }, cb = () => {}) => {
    const r = getRoom(socket.data.room);
    if (!r || !r.started || r.finished) return cb({ ok: false, error: "GAME_NOT_ACTIVE" });

    const guesser = byToken(r, socket.data.playerToken);
    if (!guesser || !guesser.alive || r.turnId !== guesser.id) {
      return cb({ ok: false, error: "NOT_YOUR_TURN" });
    }

    const target = r.players.find(p => p.id === targetId && p.alive);
    if (!target || target.id === guesser.id) return cb({ ok: false, error: "INVALID_TARGET" });
    if (!r.characterCounts[character]) return cb({ ok: false, error: "INVALID_CHARACTER" });

    if (target.character === character) {
      target.alive = false;
      r.characterCounts[character]--;
      if (r.characterCounts[character] <= 0) delete r.characterCounts[character];

      io.to(r.code).emit("guess_result", {
        result: "correct",
        guesserName: guesser.name,
        targetName: target.name,
        character
      });

      finishIfNeeded(r);
      if (!r.finished) r.turnId = guesser.id; // correct: keeps turn
    } else {
      r.turnId = target.id; // wrong: accused gets turn
      io.to(r.code).emit("guess_result", {
        result: "wrong",
        guesserName: guesser.name,
        targetName: target.name,
        character
      });
    }

    cb({ ok: true, finished: r.finished, winnerId: r.winnerId });
    emitRoom(r);
  });

  socket.on("new_game", (_, cb = () => {}) => {
    const r = getRoom(socket.data.room);
    const p = r && byToken(r, socket.data.playerToken);
    if (!r || !p || r.hostPlayerId !== p.id) return cb({ ok: false, error: "HOST_ONLY" });

    r.started = false;
    r.finished = false;
    r.turnId = null;
    r.winnerId = null;
    r.characterCounts = {};
    r.players.forEach(x => {
      x.character = "";
      x.alive = true;
    });

    cb({ ok: true });
    emitRoom(r);
  });

  socket.on("disconnect", () => {
    const r = getRoom(socket.data.room);
    if (!r) return;
    const p = byToken(r, socket.data.playerToken);
    if (p && p.socketId === socket.id) p.socketId = null;

    // IMPORTANT: player is NOT removed. Their seat survives reload/lock/reconnect.
    emitRoom(r);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Uncle Nathan 2.0 running on ${PORT}`));
