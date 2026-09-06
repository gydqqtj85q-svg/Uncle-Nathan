const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i=0;i<4;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function publicRoom(r) {
  return {
    code: r.code,
    started: r.started,
    hostId: r.hostId,
    players: r.players.map(p => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      submitted: !!p.character
    })),
    turnId: r.turnId,
    remainingCharacters: r.started
      ? Object.entries(r.characterCounts).map(([name,count]) => ({name,count}))
      : [],
    winnerId: r.winnerId || null
  };
}
function emitRoom(r) {
  io.to(r.code).emit("room_state", publicRoom(r));
}
function getRoom(c) { return rooms.get((c||"").toUpperCase()); }

app.get("/health", (_,res)=>res.json({ok:true}));

io.on("connection", socket => {
  socket.on("create_room", async ({name}, cb) => {
    let c;
    do { c = code(); } while (rooms.has(c));
    const p = { id: socket.id, name: (name||"Host").trim().slice(0,30), character:"", alive:true };
    const r = {
      code:c, hostId:socket.id, players:[p], started:false,
      turnId:null, characterCounts:{}, winnerId:null
    };
    rooms.set(c,r);
    socket.join(c);
    socket.data.room = c;
    const base = `${socket.handshake.headers["x-forwarded-proto"] || socket.handshake.protocol}://${socket.handshake.headers.host}`;
    const joinUrl = `${base}/?room=${c}`;
    let qr = "";
    try { qr = await QRCode.toDataURL(joinUrl, { margin:1, width:640 }); } catch(e){}
    cb?.({ok:true, code:c, joinUrl, qr});
    emitRoom(r);
  });

  socket.on("join_room", ({code:roomCode,name}, cb) => {
    const r = getRoom(roomCode);
    if (!r) return cb?.({ok:false,error:"ROOM_NOT_FOUND"});
    if (r.started) return cb?.({ok:false,error:"GAME_STARTED"});
    const clean = (name||"").trim().slice(0,30);
    if (!clean) return cb?.({ok:false,error:"NAME_REQUIRED"});
    if (r.players.some(p=>p.name.toLowerCase()===clean.toLowerCase())) {
      return cb?.({ok:false,error:"NAME_TAKEN"});
    }
    r.players.push({id:socket.id,name:clean,character:"",alive:true});
    socket.join(r.code);
    socket.data.room = r.code;
    cb?.({ok:true, code:r.code});
    emitRoom(r);
  });

  socket.on("submit_character", ({character}, cb) => {
    const r = getRoom(socket.data.room);
    if (!r || r.started) return cb?.({ok:false});
    const p = r.players.find(x=>x.id===socket.id);
    const ch = (character||"").trim().slice(0,50);
    if (!p || !ch) return cb?.({ok:false,error:"CHARACTER_REQUIRED"});
    p.character = ch;
    cb?.({ok:true});
    emitRoom(r);
  });

  socket.on("start_game", (_, cb) => {
    const r = getRoom(socket.data.room);
    if (!r || r.hostId!==socket.id) return cb?.({ok:false,error:"HOST_ONLY"});
    if (r.players.length < 2) return cb?.({ok:false,error:"NEED_PLAYERS"});
    if (r.players.some(p=>!p.character)) return cb?.({ok:false,error:"WAITING_SUBMISSIONS"});
    r.started = true;
    r.turnId = r.players[Math.floor(Math.random()*r.players.length)].id;
    r.characterCounts = {};
    for (const p of r.players) r.characterCounts[p.character]=(r.characterCounts[p.character]||0)+1;
    emitRoom(r);
    cb?.({ok:true});
  });

  socket.on("guess", ({targetId,character}, cb) => {
    const r = getRoom(socket.data.room);
    if (!r || !r.started) return cb?.({ok:false});
    if (r.turnId!==socket.id) return cb?.({ok:false,error:"NOT_YOUR_TURN"});
    const guesser = r.players.find(p=>p.id===socket.id && p.alive);
    const target = r.players.find(p=>p.id===targetId && p.alive);
    if (!guesser || !target || target.id===guesser.id) return cb?.({ok:false,error:"INVALID_TARGET"});
    if (!r.characterCounts[character]) return cb?.({ok:false,error:"INVALID_CHARACTER"});

    if (target.character === character) {
      target.alive = false;
      r.characterCounts[character]--;
      if (r.characterCounts[character] <= 0) delete r.characterCounts[character];
      const alive = r.players.filter(p=>p.alive);
      if (alive.length===1) {
        r.winnerId = alive[0].id;
        r.turnId = alive[0].id;
      } else {
        // successful guesser keeps the turn
        r.turnId = guesser.id;
      }
      io.to(r.code).emit("guess_result", {
        result:"correct",
        guesserName:guesser.name,
        targetName:target.name,
        character
      });
    } else {
      r.turnId = target.id;
      io.to(r.code).emit("guess_result", {
        result:"wrong",
        guesserName:guesser.name,
        targetName:target.name,
        character
      });
    }
    emitRoom(r);
    cb?.({ok:true});
  });

  socket.on("disconnect", () => {
    const r = getRoom(socket.data.room);
    if (!r) return;
    if (!r.started) {
      r.players = r.players.filter(p=>p.id!==socket.id);
      if (r.players.length===0) rooms.delete(r.code);
      else {
        if (r.hostId===socket.id) r.hostId=r.players[0].id;
        emitRoom(r);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Who Picked It running on ${PORT}`));
