// 종단간(E2E) 자동 테스트: 실제 서버를 띄우고 socket.io 클라이언트 여러 개로 게임을 진행해 봅니다.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3900 + Math.floor(Math.random() * 90);
const URL = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-e2e-'));
const CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ port: PORT, adminPin: '1234', rounds: 5, payoff: { CC: 3, CD: 0, DC: 5, DD: 1 }, publicUrl: '', cleanupHours: 6 }));

let srv;
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✔', msg); }
  else { failed++; console.log('  ✘', msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), CONFIG_PATH, DATA_DIR: path.join(TMP, 'data') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    srv.stdout.on('data', (d) => { out += d; if (out.includes('서버가 켜졌어요')) resolve(); });
    srv.stderr.on('data', (d) => process.stderr.write(d));
    srv.on('exit', (c) => { if (!out.includes('켜졌어요')) reject(new Error('server exit ' + c)); });
  });
}
function stopServer() {
  return new Promise((r) => { srv.on('exit', r); srv.kill('SIGTERM'); });
}

class Player {
  constructor(label) {
    this.label = label;
    this.views = [];
    this.waiters = [];
  }
  connect() {
    this.s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
    this.s.on('state', (v) => {
      this.view = v;
      this.views.push(v);
      this.waiters = this.waiters.filter((w) => (w.pred(v) ? (w.resolve(v), false) : true));
    });
    return new Promise((r) => this.s.on('connect', r));
  }
  emit(ev, data) { return new Promise((r) => this.s.emit(ev, data, r)); }
  waitFor(pred, ms = 3000) {
    if (this.view && pred(this.view)) return Promise.resolve(this.view);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => reject(new Error(`${this.label}: 상태 대기 시간 초과`)), ms);
    });
  }
  disconnect() { this.s.disconnect(); }
}

async function api(p, body, pin = '1234') {
  const r = await fetch(URL + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Admin-Pin': pin }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function getStats() {
  const m = io(URL, { transports: ['websocket'], forceNew: true });
  const s = await new Promise((r) => { m.on('stats', r); m.on('connect', () => m.emit('monitor')); });
  m.disconnect();
  return s;
}

async function newGame(nameA = '철수', nameB = '영희') {
  const A = new Player('A'), B = new Player('B');
  await A.connect(); await B.connect();
  const c = await A.emit('create', { name: nameA });
  const j = await B.emit('join', { code: c.code, name: nameB });
  await A.waitFor((v) => v.status === 'playing');
  await B.waitFor((v) => v.status === 'playing');
  return { A, B, code: c.code, tokA: c.token, tokB: j.token, c, j };
}

function hiddenDuringPlay(v) {
  return v.status !== 'finished' && v.history === undefined && v.totals === undefined;
}

async function playRound(A, B, a, b) {
  const startRound = A.view.round;
  const r1 = await A.emit('choose', { choice: a });
  const r2 = await B.emit('choose', { choice: b });
  await A.waitFor((v) => v.status === 'finished' || v.round > startRound);
  await B.waitFor((v) => v.status === 'finished' || v.round > startRound);
  return r1.ok && r2.ok;
}

(async () => {
  await startServer();
  console.log(`서버 시작: ${URL}  (임시 폴더 ${TMP})`);

  // 1. 방 만들기 / 참가
  console.log('\n[1] 방 만들기 · 참가');
  const g1 = await newGame();
  ok(/^\d{4}$/.test(g1.code), `4자리 방 코드 생성 (${g1.code})`);
  ok(g1.j.ok && g1.A.view.status === 'playing' && g1.B.view.status === 'playing', '두 명이 들어오면 게임 시작');
  ok(g1.A.view.seat === 0 && g1.B.view.seat === 1, '자리 배정 (A=0, B=1)');
  ok(g1.A.view.players[1].name === '영희' && g1.B.view.players[0].name === '철수', '서로 이름 보임');
  ok(g1.A.view.players[1].connected && g1.B.view.players[0].connected, '상대 접속 상태 = 접속 중');
  const third = new Player('C'); await third.connect();
  const full = await third.emit('join', { code: g1.code, name: '셋째' });
  ok(!full.ok && /찼/.test(full.error), '세 번째 사람은 참가 불가 (방 꽉 참)');
  const bad = await third.emit('join', { code: '0000', name: 'x' });
  ok(!bad.ok, '없는 방 코드는 오류');
  third.disconnect();
  const qr = await fetch(`${URL}/api/qr.svg?code=${g1.code}`);
  ok(qr.status === 200 && (await qr.text()).startsWith('<svg'), 'QR 코드(SVG) 생성 (오프라인)');

  // 2. 선택 숨기기
  console.log('\n[2] 상대 선택 숨기기');
  const { A, B } = g1;
  B.views = [];
  await A.emit('choose', { choice: 'D' });
  const bv = await B.waitFor((v) => v.opponentChosen === true);
  ok(bv.myChoice === null && hiddenDuringPlay(bv), 'A가 골라도 B 화면에는 "골랐다"는 사실만 전달 (기록·합계 없음)');
  ok(!JSON.stringify(B.views).includes('"D"'), 'B에게 간 데이터 어디에도 A의 선택(배신)이 없음');
  ok(!('choices' in bv), '서버 응답에 상대 현재 선택 필드 없음');
  const again = await A.emit('choose', { choice: 'C' });
  ok(!again.ok, '한 라운드에 두 번 고를 수 없음');
  await B.emit('choose', { choice: 'D' });
  await A.waitFor((v) => v.round === 2);
  await B.waitFor((v) => v.round === 2);
  ok(A.view.status === 'playing' && A.view.round === 2 && A.view.myChoice === null, '1라운드가 끝나면 바로 2라운드로');
  ok(hiddenDuringPlay(A.view) && hiddenDuringPlay(B.view), '라운드가 끝나도 게임이 끝날 때까지 결과(기록·사탕)를 보내지 않음');

  // 3. 4가지 조합 + 5라운드
  console.log('\n[3] 보상 계산 (4가지 조합) · 5라운드');
  await playRound(A, B, 'C', 'C'); // 3/3
  await playRound(A, B, 'C', 'D'); // 0/5
  await playRound(A, B, 'D', 'C'); // 5/0
  ok(A.view.status === 'playing' && A.view.round === 5 && hiddenDuringPlay(A.view), '4라운드 후 아직 진행 중 (5라운드 차례), 결과는 숨김');
  await playRound(A, B, 'C', 'C'); // 3/3
  const cand = A.view.history.map((h) => h.candies.join('/')).join(' ');
  ok(cand === '1/1 3/3 0/5 5/0 3/3', `종료 후 라운드별 사탕: ${cand}`);
  ok(A.view.status === 'finished' && B.view.status === 'finished', '5라운드 후 게임 종료');
  ok(A.view.totals.join() === '12,12' && B.view.totals.join() === '12,12', `합계 A=${A.view.totals[0]}, B=${A.view.totals[1]} (기대 12/12)`);
  const late = await A.emit('choose', { choice: 'C' });
  ok(!late.ok, '끝난 게임에서는 선택 불가');

  // 4. 동시에 두 방 + 재접속
  console.log('\n[4] 두 방 동시 진행 + 새로고침/재접속');
  const g2 = await newGame('민수', '지아');
  const g3 = await newGame('하준', '서윤');
  ok(g2.code !== g3.code, `서로 다른 방 코드 (${g2.code}, ${g3.code})`);
  await g2.A.emit('choose', { choice: 'C' });
  await g3.A.emit('choose', { choice: 'D' });
  await g3.B.emit('choose', { choice: 'D' });
  await g2.B.emit('choose', { choice: 'D' });
  await g2.A.waitFor((v) => v.round === 2);
  await g3.A.waitFor((v) => v.round === 2);
  ok(hiddenDuringPlay(g2.A.view) && hiddenDuringPlay(g3.A.view), '진행 중에는 두 방 모두 플레이어에게 기록이 안 보임');
  const midRooms = (await api('/api/admin/rooms')).json;
  const r2admin = midRooms.find((r) => r.code === g2.code);
  const r3admin = midRooms.find((r) => r.code === g3.code);
  ok(r2admin && r2admin.totals.join() === '0,5', '방 2: 협력/배신 → 0/5 (관리자 기록)');
  ok(r3admin && r3admin.totals.join() === '1,1', '방 3: 배신/배신 → 1/1 (섞이지 않음)');

  // g2 A가 2라운드에서 고른 뒤 새로고침(연결 끊김)
  await g2.A.emit('choose', { choice: 'D' });
  g2.A.disconnect();
  await g2.B.waitFor((v) => v.players[0].connected === false);
  ok(true, '상대가 끊기면 B 화면에 "연결 끊김" 표시');
  const A2 = new Player('A2'); await A2.connect();
  const res = await A2.emit('resume', { code: g2.code, token: g2.tokA });
  ok(res.ok, '저장된 토큰으로 같은 자리에 복귀');
  ok(A2.view && A2.view.seat === 0 && A2.view.myChoice === 'D' && A2.view.round === 2 && hiddenDuringPlay(A2.view), '복귀 후 이전 상태(이번 라운드 내 선택 포함) 그대로, 결과는 숨김');
  await g2.B.waitFor((v) => v.players[0].connected === true);
  ok(true, 'B 화면에 다시 "접속 중"');
  const wrong = await A2.emit('resume', { code: g2.code, token: 'nope' });
  ok(!wrong.ok, '틀린 토큰으로는 복귀 불가');
  await A2.emit('resume', { code: g2.code, token: g2.tokA });
  await g2.B.emit('choose', { choice: 'D' });
  await A2.waitFor((v) => v.round === 3);
  ok(A2.view.status === 'playing' && A2.view.round === 3 && hiddenDuringPlay(A2.view), '복귀한 뒤에도 라운드 정상 진행, 결과는 숨김');

  // 5. 서버 재시작해도 방 유지
  console.log('\n[5] 서버 재시작 후에도 방 유지');
  await sleep(400);
  await stopServer();
  await startServer();
  const A3 = new Player('A3'), B3 = new Player('B3');
  await A3.connect(); await B3.connect();
  ok((await A3.emit('resume', { code: g2.code, token: g2.tokA })).ok && (await B3.emit('resume', { code: g2.code, token: g2.tokB })).ok, '재시작 후 두 사람 모두 복귀');
  await A3.waitFor((v) => v.players[1] && v.players[1].connected);
  ok(A3.view.round === 3 && A3.view.status === 'playing' && hiddenDuringPlay(A3.view), '재시작 후 진행 상태 유지, 결과는 종료 전까지 숨김');
  await playRound(A3, B3, 'C', 'C');
  await playRound(A3, B3, 'C', 'C');
  await playRound(A3, B3, 'D', 'D');
  ok(A3.view.status === 'finished' && A3.view.totals.join() === '8,13', `방 2 최종 합계 ${A3.view.totals} (기대 8,13)`);
  ok(A3.view.history.map((h) => h.candies.join('/')).join(' ') === '0/5 1/1 3/3 3/3 1/1', '종료 후에야 전체 라운드 기록이 공개됨');

  // 6. 관리자: 보상 변경은 새 게임부터
  console.log('\n[6] 관리자 화면 (PIN, 보상표·라운드 변경)');
  ok((await api('/api/admin/config', null, '9999')).status === 401, '틀린 PIN 거부');
  const cfg = await api('/api/admin/config');
  ok(cfg.status === 200 && cfg.json.payoff.CC === 3, '맞는 PIN(1234)으로 설정 조회');
  const g4 = await newGame('옛방A', '옛방B'); // 변경 전 만든 방
  const save = await api('/api/admin/config', { payoff: { CC: 10, CD: 2, DC: 7, DD: 4 }, rounds: 3 });
  ok(save.status === 200 && save.json.config.payoff.CC === 10 && save.json.config.rounds === 3, '보상표/라운드 수 저장');
  const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  ok(saved.payoff.CC === 10 && saved.rounds === 3, 'config.json 파일에도 저장됨');
  await playRound(g4.A, g4.B, 'C', 'C');
  ok(g4.A.view.totalRounds === 5 && g4.A.view.payoff.CC === 3 && hiddenDuringPlay(g4.A.view), '이미 만든 방은 예전 보상표(3/3, 5라운드) 유지, 결과는 숨김');
  const g4room = (await api('/api/admin/rooms')).json.find((r) => r.code === g4.code);
  ok(g4room && g4room.totals.join() === '3,3', '예전 보상표로 1라운드 계산 3/3 (관리자 기록)');
  const g5 = await newGame('새방A', '새방B');
  ok(g5.A.view.totalRounds === 3 && g5.A.view.payoff.CC === 10, '새 방은 새 보상표·3라운드');
  await playRound(g5.A, g5.B, 'C', 'C');
  await playRound(g5.A, g5.B, 'C', 'D');
  await playRound(g5.A, g5.B, 'D', 'D');
  ok(g5.A.view.status === 'finished' && g5.A.view.totals.join() === '16,21', `새 보상표 합계 ${g5.A.view.totals} (기대 10+2+4=16, 10+7+4=21)`);

  // 7. 모니터 통계
  console.log('\n[7] 부스 모니터 통계');
  const st = await getStats();
  // 끝난 라운드: g1 5 + g2 5 + g3 1 + g4 1 + g5 3 = 15
  ok(st.rounds === 15, `진행된 라운드 수 ${st.rounds} (기대 15)`);
  ok(st.cooperate + st.betray === 30, `전체 선택 수 ${st.cooperate + st.betray} (기대 30)`);
  // 협력 수 계산: g1 (DD,CC,CD,DC,CC)=C 6; g2 (CD,DD,CC,CC,DD)=5; g3 DD=0; g4 CC=2; g5 (CC,CD,DD)=3 → 16
  ok(st.cooperate === 16 && st.betray === 14, `협력 ${st.cooperate} / 배신 ${st.betray} (기대 16/14)`);
  ok(st.bothCooperate === 6 && st.bothBetray === 5 && st.mixed === 4, `서로 협력 ${st.bothCooperate}, 서로 배신 ${st.bothBetray}, 엇갈림 ${st.mixed}`);
  ok(st.gamesFinished === 3, `끝난 게임 ${st.gamesFinished} (기대 3)`);
  ok(st.byRound[1].cooperate + st.byRound[1].betray === 10, '1라운드 통계: 5개 방 × 2명 = 10 선택');
  // 실시간 업데이트 확인
  const m = io(URL, { transports: ['websocket'], forceNew: true });
  const updates = [];
  await new Promise((r) => { m.on('stats', (s) => { updates.push(s); if (updates.length === 1) r(); }); m.on('connect', () => m.emit('monitor')); });
  await playRound(g4.A, g4.B, 'C', 'C');
  await sleep(300);
  ok(updates.length >= 2 && updates[updates.length - 1].rounds === 16, '라운드가 끝나면 모니터에 실시간 반영');
  const rs = await api('/api/admin/reset-stats', {});
  await sleep(300);
  ok(rs.status === 200 && updates[updates.length - 1].rounds === 0 && updates[updates.length - 1].cooperate === 0, '관리자 "통계 초기화" 동작');
  ok((await api('/api/admin/reset-stats', {}, 'x')).status === 401, '통계 초기화도 PIN 필요');
  m.disconnect();

  // 8. 관리자 방 목록/삭제
  console.log('\n[8] 관리자 방 관리');
  const rooms = await api('/api/admin/rooms');
  ok(rooms.json.length === 5, `방 목록 ${rooms.json.length}개`);
  const cf = await api('/api/admin/cleanup-finished', {});
  ok(cf.json.removed === 3, `끝난 방 정리 ${cf.json.removed}개`);

  [g1.A, g1.B, g2.B, g3.A, g3.B, g4.A, g4.B, g5.A, g5.B, A2, A3, B3].forEach((p) => p.s.connected && p.disconnect());
  await stopServer();
  console.log(`\n결과: ${passed}개 통과, ${failed}개 실패`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('테스트 중 오류:', e);
  try { await stopServer(); } catch (_) {}
  process.exit(1);
});
