'use strict';
/*
 * 죄수의 딜레마 체험 부스 서버 (야탑제 · 심리탐구 동아리)
 * Express + Socket.IO, 상태는 data/state.json 에 저장됩니다.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const ROOT = __dirname;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

// ---------- 설정 ----------
const DEFAULT_CONFIG = {
  port: 3000,
  adminPin: '1234',
  rounds: 5,
  payoff: { CC: 3, CD: 0, DC: 5, DD: 1 },
  publicUrl: '',
  cleanupHours: 6,
};

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[설정] config.json 을 읽을 수 없어 기본값을 씁니다:', e.message);
  }
  const merged = { ...DEFAULT_CONFIG, ...cfg, payoff: { ...DEFAULT_CONFIG.payoff, ...(cfg.payoff || {}) } };
  return sanitizeConfig(merged);
}

function toInt(v, def, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function sanitizeConfig(c) {
  return {
    port: toInt(c.port, 3000, 1, 65535),
    adminPin: String(c.adminPin ?? '1234'),
    rounds: toInt(c.rounds, 5, 1, 20),
    payoff: {
      CC: toInt(c.payoff.CC, 3, 0, 999),
      CD: toInt(c.payoff.CD, 0, 0, 999),
      DC: toInt(c.payoff.DC, 5, 0, 999),
      DD: toInt(c.payoff.DD, 1, 0, 999),
    },
    publicUrl: String(c.publicUrl || '').trim().replace(/\/+$/, ''),
    cleanupHours: Math.max(0.1, Number(c.cleanupHours) || 6),
  };
}

let config = loadConfig();
// 배포 환경(Render 등)에서는 환경변수 ADMIN_PIN 으로 관리자 PIN을 덮어씀
if (process.env.ADMIN_PIN) config.adminPin = String(process.env.ADMIN_PIN);

function saveConfig() {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
}

// ---------- 상태 저장 ----------
function emptyStats() {
  return {
    cooperate: 0, betray: 0, // 개인 선택 수
    rounds: 0, // 끝난 라운드 수
    bothCooperate: 0, bothBetray: 0, mixed: 0,
    gamesFinished: 0,
    byRound: {}, // 라운드 번호 -> {cooperate, betray}
    since: Date.now(),
  };
}

let state = { rooms: {}, stats: emptyStats() };
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const loaded = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  state.rooms = loaded.rooms || {};
  state.stats = { ...emptyStats(), ...(loaded.stats || {}) };
  console.log(`[저장] 이전 상태를 불러왔어요 (방 ${Object.keys(state.rooms).length}개)`);
} catch (e) {
  if (e.code !== 'ENOENT') console.error('[저장] state.json 을 읽지 못했어요. 새로 시작합니다:', e.message);
}

let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeStateNow();
  }, 150);
}
function writeStateNow() {
  try {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) {
    console.error('[저장] 실패:', e.message);
  }
}

// ---------- 네트워크 주소 ----------
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifs)) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' && i.family !== 4) continue;
      if (i.internal) continue;
      if (/^169\.254\./.test(i.address)) continue; // 자동 할당(연결 안 됨)
      if (/docker|veth|br-|vmnet|vboxnet|virtualbox|vEthernet|utun|tailscale|zt/i.test(name)) continue;
      out.push({ name, address: i.address });
    }
  }
  const score = (a) => (/^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  out.sort((x, y) => score(x.address) - score(y.address));
  return out;
}

const PORT = toInt(process.env.PORT || config.port, 3000, 1, 65535);

function baseUrlFor(req) {
  if (config.publicUrl) return config.publicUrl;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const isLocal = !hostname || hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname) || hostname === '0.0.0.0';
  if (!isLocal) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    return `${proto}://${host}`;
  }
  const ip = lanIPs()[0];
  return ip ? `http://${ip.address}:${PORT}` : `http://localhost:${PORT}`;
}

// ---------- 방 ----------
const ROUND_KEY = (me, other) => me + other; // 'CC' | 'CD' | 'DC' | 'DD'

function newCode() {
  for (let i = 0; i < 2000; i++) {
    const code = String(crypto.randomInt(1000, 10000));
    if (!state.rooms[code]) return code;
  }
  // 거의 일어나지 않지만 5자리로 늘려서라도 만든다
  for (;;) {
    const code = String(crypto.randomInt(10000, 100000));
    if (!state.rooms[code]) return code;
  }
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

function cleanName(n, fallback) {
  const s = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return s || fallback;
}

function createRoom(name) {
  const code = newCode();
  const now = Date.now();
  const room = {
    code,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    status: 'waiting', // waiting | playing | finished
    totalRounds: config.rounds,
    payoff: { ...config.payoff }, // 방을 만든 시점의 보상표를 고정
    players: [{ token: newToken(), name: cleanName(name, '플레이어 1') }, null],
    choices: [null, null],
    history: [],
  };
  state.rooms[code] = room;
  saveState();
  return room;
}

function seatOf(room, token) {
  if (!room || !token) return -1;
  return room.players.findIndex((p) => p && p.token === token);
}

function isConnected(code, seat) {
  const r = io.sockets.adapter.rooms.get(`${code}:${seat}`);
  return !!(r && r.size > 0);
}

function totals(room) {
  const t = [0, 0];
  for (const h of room.history) {
    t[0] += h.candies[0];
    t[1] += h.candies[1];
  }
  return t;
}

// 각 플레이어에게 보낼 화면 정보. 상대의 '이번 라운드' 선택은 절대 넣지 않는다.
function viewFor(room, seat) {
  const other = 1 - seat;
  return {
    code: room.code,
    seat,
    status: room.status,
    totalRounds: room.totalRounds,
    round: Math.min(room.history.length + 1, room.totalRounds),
    payoff: room.payoff,
    players: room.players.map((p, i) =>
      p ? { name: p.name, connected: isConnected(room.code, i), isMe: i === seat } : null
    ),
    myChoice: room.choices[seat],
    opponentChosen: room.choices[other] !== null,
    history: room.history,
    totals: totals(room),
  };
}

function broadcastRoom(room) {
  for (const seat of [0, 1]) {
    if (room.players[seat]) io.to(`${room.code}:${seat}`).emit('state', viewFor(room, seat));
  }
}

function publicStats() {
  const s = state.stats;
  const rooms = Object.values(state.rooms);
  return {
    ...s,
    activeRooms: rooms.filter((r) => r.status === 'playing').length,
    waitingRooms: rooms.filter((r) => r.status === 'waiting').length,
    payoff: config.payoff,
    configRounds: config.rounds,
  };
}

let monitorTimer = null;
function broadcastStats() {
  if (monitorTimer) return;
  monitorTimer = setTimeout(() => {
    monitorTimer = null;
    io.to('monitor').emit('stats', publicStats());
  }, 100);
}

function recordStats(roundNo, a, b) {
  const s = state.stats;
  for (const c of [a, b]) {
    if (c === 'C') s.cooperate++;
    else s.betray++;
  }
  s.rounds++;
  if (a === 'C' && b === 'C') s.bothCooperate++;
  else if (a === 'D' && b === 'D') s.bothBetray++;
  else s.mixed++;
  const br = (s.byRound[roundNo] = s.byRound[roundNo] || { cooperate: 0, betray: 0 });
  for (const c of [a, b]) c === 'C' ? br.cooperate++ : br.betray++;
}

function choose(room, seat, choice) {
  if (room.status !== 'playing') return '지금은 선택할 수 없어요.';
  if (choice !== 'C' && choice !== 'D') return '잘못된 선택이에요.';
  if (room.choices[seat] !== null) return '이번 라운드는 이미 골랐어요.';
  room.choices[seat] = choice;
  room.updatedAt = Date.now();
  if (room.choices[0] !== null && room.choices[1] !== null) {
    const [a, b] = room.choices;
    const roundNo = room.history.length + 1;
    room.history.push({
      round: roundNo,
      choices: [a, b],
      candies: [room.payoff[ROUND_KEY(a, b)], room.payoff[ROUND_KEY(b, a)]],
    });
    room.choices = [null, null];
    recordStats(roundNo, a, b);
    if (room.history.length >= room.totalRounds) {
      room.status = 'finished';
      room.finishedAt = Date.now();
      state.stats.gamesFinished++;
    }
    broadcastStats();
  }
  saveState();
  return null;
}

// 오래된 방 정리
function cleanup() {
  const now = Date.now();
  const hour = 3600 * 1000;
  let removed = 0;
  for (const [code, r] of Object.entries(state.rooms)) {
    const age = now - (r.updatedAt || r.createdAt);
    const limit = r.status === 'finished' ? config.cleanupHours * hour : Math.max(config.cleanupHours, 12) * hour;
    if (age > limit) {
      delete state.rooms[code];
      removed++;
    }
  }
  if (removed) {
    console.log(`[정리] 오래된 방 ${removed}개를 지웠어요`);
    saveState();
    broadcastStats();
  }
}
setInterval(cleanup, 10 * 60 * 1000).unref();

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '20kb' }));

app.get('/api/info', (req, res) => {
  res.json({ baseUrl: baseUrlFor(req), lan: lanIPs(), port: PORT, payoff: config.payoff, rounds: config.rounds });
});

app.get('/api/qr.svg', async (req, res) => {
  const code = String(req.query.code || '').replace(/\D/g, '').slice(0, 6);
  const target = code ? `${baseUrlFor(req)}/?join=${code}` : baseUrlFor(req) + '/';
  try {
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (e) {
    res.status(500).send('QR error');
  }
});

function requirePin(req, res, next) {
  const pin = String(req.headers['x-admin-pin'] || '');
  if (pin && pin === config.adminPin) return next();
  res.status(401).json({ error: 'PIN이 틀렸어요.' });
}

app.post('/api/admin/login', requirePin, (req, res) => res.json({ ok: true }));

app.get('/api/admin/config', requirePin, (req, res) => {
  res.json({ ...config, lan: lanIPs(), port: PORT });
});

app.post('/api/admin/config', requirePin, (req, res) => {
  const b = req.body || {};
  const next = sanitizeConfig({
    ...config,
    ...('rounds' in b ? { rounds: b.rounds } : {}),
    ...('publicUrl' in b ? { publicUrl: b.publicUrl } : {}),
    ...('cleanupHours' in b ? { cleanupHours: b.cleanupHours } : {}),
    ...(b.adminPin ? { adminPin: b.adminPin } : {}),
    payoff: { ...config.payoff, ...(b.payoff || {}) },
  });
  config = next;
  try {
    saveConfig();
  } catch (e) {
    return res.status(500).json({ error: '설정 파일 저장 실패: ' + e.message });
  }
  broadcastStats();
  res.json({ ok: true, config });
});

app.post('/api/admin/reset-stats', requirePin, (req, res) => {
  state.stats = emptyStats();
  saveState();
  broadcastStats();
  res.json({ ok: true });
});

app.get('/api/admin/rooms', requirePin, (req, res) => {
  const list = Object.values(state.rooms)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({
      code: r.code,
      status: r.status,
      createdAt: r.createdAt,
      round: r.history.length,
      totalRounds: r.totalRounds,
      players: r.players.map((p, i) => (p ? { name: p.name, connected: isConnected(r.code, i) } : null)),
      totals: totals(r),
    }));
  res.json(list);
});

app.post('/api/admin/delete-room', requirePin, (req, res) => {
  const code = String((req.body || {}).code || '');
  const room = state.rooms[code];
  if (room) {
    delete state.rooms[code];
    io.to(`${code}:0`).to(`${code}:1`).emit('room-closed');
    saveState();
    broadcastStats();
  }
  res.json({ ok: true });
});

app.post('/api/admin/cleanup-finished', requirePin, (req, res) => {
  let n = 0;
  for (const [code, r] of Object.entries(state.rooms)) {
    if (r.status === 'finished') {
      delete state.rooms[code];
      n++;
    }
  }
  saveState();
  broadcastStats();
  res.json({ ok: true, removed: n });
});

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/monitor', (req, res) => res.sendFile(path.join(ROOT, 'public', 'monitor.html')));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// ---------- Socket.IO ----------
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 8000,
});

function attach(socket, room, seat) {
  // 이전에 붙어 있던 방에서 떼기
  if (socket.data.code) {
    socket.leave(`${socket.data.code}:${socket.data.seat}`);
    const prev = state.rooms[socket.data.code];
    socket.data.code = null;
    if (prev && prev !== room) broadcastRoom(prev);
  }
  socket.data.code = room.code;
  socket.data.seat = seat;
  socket.join(`${room.code}:${seat}`);
}

io.on('connection', (socket) => {
  const reply = (cb, data) => typeof cb === 'function' && cb(data);

  socket.on('create', (msg, cb) => {
    const room = createRoom(msg && msg.name);
    attach(socket, room, 0);
    broadcastRoom(room);
    reply(cb, { ok: true, code: room.code, token: room.players[0].token });
    broadcastStats();
  });

  socket.on('join', (msg, cb) => {
    const code = String((msg && msg.code) || '').replace(/\D/g, '');
    const room = state.rooms[code];
    if (!room) return reply(cb, { ok: false, error: '그런 방이 없어요. 방 코드를 다시 확인해 주세요.' });
    // 이미 이 방 사람인 경우(같은 토큰) 그대로 복귀
    const existing = seatOf(room, msg && msg.token);
    if (existing >= 0) {
      attach(socket, room, existing);
      broadcastRoom(room);
      return reply(cb, { ok: true, code, token: room.players[existing].token });
    }
    if (room.players[1]) return reply(cb, { ok: false, error: '이 방은 이미 2명이 다 찼어요.' });
    room.players[1] = { token: newToken(), name: cleanName(msg && msg.name, '플레이어 2') };
    if (room.players[0].name === room.players[1].name) room.players[1].name += ' (2)';
    room.status = 'playing';
    room.updatedAt = Date.now();
    attach(socket, room, 1);
    saveState();
    broadcastRoom(room);
    reply(cb, { ok: true, code, token: room.players[1].token });
    broadcastStats();
  });

  socket.on('resume', (msg, cb) => {
    const code = String((msg && msg.code) || '');
    const room = state.rooms[code];
    const seat = seatOf(room, msg && msg.token);
    if (seat < 0) return reply(cb, { ok: false, error: '이전 게임을 찾을 수 없어요.' });
    attach(socket, room, seat);
    broadcastRoom(room);
    reply(cb, { ok: true });
  });

  socket.on('choose', (msg, cb) => {
    const room = state.rooms[socket.data.code];
    if (!room) return reply(cb, { ok: false, error: '방을 찾을 수 없어요.' });
    const err = choose(room, socket.data.seat, msg && msg.choice);
    if (err) {
      reply(cb, { ok: false, error: err });
      return socket.emit('state', viewFor(room, socket.data.seat));
    }
    broadcastRoom(room);
    reply(cb, { ok: true });
  });

  socket.on('leave', (msg, cb) => {
    const room = state.rooms[socket.data.code];
    if (room) {
      socket.leave(`${room.code}:${socket.data.seat}`);
      // 아직 아무도 안 들어온 대기방이면 방을 지운다
      if (room.status === 'waiting' && socket.data.seat === 0) {
        delete state.rooms[room.code];
        saveState();
        broadcastStats();
      } else {
        broadcastRoom(room);
      }
    }
    socket.data.code = null;
    reply(cb, { ok: true });
  });

  socket.on('monitor', () => {
    socket.join('monitor');
    socket.emit('stats', publicStats());
  });

  socket.on('disconnect', () => {
    const room = state.rooms[socket.data.code];
    if (room) broadcastRoom(room);
  });
});

function shutdown() {
  writeStateNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('');
  console.log('========================================');
  console.log(' 죄수의 딜레마 체험 부스 서버가 켜졌어요!');
  console.log('========================================');
  console.log(` 이 노트북에서:   http://localhost:${PORT}`);
  for (const ip of ips) console.log(` 다른 기기에서:   http://${ip.address}:${PORT}   (${ip.name})`);
  if (!ips.length) console.log(' (와이파이/네트워크 주소를 찾지 못했어요. 와이파이 연결을 확인하세요)');
  if (config.publicUrl) console.log(` QR 주소(설정값): ${config.publicUrl}`);
  console.log(` 관리자 화면:     http://localhost:${PORT}/admin   (PIN: config.json 의 adminPin)`);
  console.log(` 부스 모니터:     http://localhost:${PORT}/monitor`);
  console.log('');
});

module.exports = { server };
