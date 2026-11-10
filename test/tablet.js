// 태블릿 호환성 테스트: 여러 태블릿 화면 크기/방향 × 브라우저 엔진으로 전체 흐름을 '탭'으로 진행하며
// 가로 스크롤, 터치 영역(48px), 글자 크기, 첫 화면에 버튼이 보이는지 등을 검사합니다.
// 사용법: 서버를 켠 상태에서  BASE=http://localhost:3000 node test/tablet.js
'use strict';
const path = require('path');
const fs = require('fs');
const pw = require('playwright-core');

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'screenshots', 'tablet');
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
fs.mkdirSync(OUT, { recursive: true });
const D = pw.devices;

// [이름, 기기 설명, 스크린샷 저장 여부]
const DEVICES = [
  ['ipad7-portrait', D['iPad (gen 7)'], true],
  ['ipad7-landscape', D['iPad (gen 7) landscape'], true],
  ['ipadpro11-portrait', D['iPad Pro 11'], false],
  ['ipadpro11-landscape', D['iPad Pro 11 landscape'], true],
  ['ipadmini-landscape', D['iPad Mini landscape'], false],
  ['ipad11gen-portrait', D['iPad (gen 11)'], false],
  ['galaxytabs4-portrait', D['Galaxy Tab S4'], true],
  ['galaxytabs4-landscape', D['Galaxy Tab S4 landscape'], false],
  ['android800x1280-portrait', D['Nexus 10'], false],
  ['android1280x800-landscape', D['Nexus 10 landscape'], true],
  ['galaxytabs9-landscape', D['Galaxy Tab S9 landscape'], false],
];
const ENGINES = (process.env.ENGINES || 'chromium,firefox').split(',');
const FIREFOX_DEVICES = ['ipad7-portrait', 'ipad7-landscape', 'android800x1280-portrait', 'android1280x800-landscape'];

let fails = 0;
const problems = [];
function check(c, label, msg) {
  if (!c) { fails++; problems.push(`${label}: ${msg}`); console.log(`  ✘ ${label}: ${msg}`); }
}

async function audit(page, label, screen) {
  const r = await page.evaluate(() => {
    const vis = (el) => {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && el.offsetParent !== null;
    };
    const small = [];
    document.querySelectorAll('button, a, input, select, summary, [role=button]').forEach((el) => {
      if (!vis(el)) return;
      const b = el.getBoundingClientRect();
      if (b.height < 47.5 || b.width < 47.5) small.push(`${el.tagName.toLowerCase()}#${el.id || ''}"${(el.textContent || el.value || '').trim().slice(0, 12)}" ${Math.round(b.width)}x${Math.round(b.height)}`);
    });
    let minFont = 99, minText = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (!t.textContent.trim()) continue;
      const el = t.parentElement;
      if (!el || !vis(el) || el.closest('.hidden')) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < minFont) { minFont = fs; minText = t.textContent.trim().slice(0, 20); }
    }
    const wrap = document.querySelector('.wrap, .mwrap');
    return {
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      small, minFont, minText,
      vw: window.innerWidth, vh: window.innerHeight,
      wrapW: wrap ? Math.round(wrap.getBoundingClientRect().width) : 0,
      docH: document.documentElement.scrollHeight,
    };
  });
  check(r.overflowX <= 1, label, `${screen}: 가로 스크롤 발생 (+${r.overflowX}px)`);
  check(r.small.length === 0, label, `${screen}: 48px보다 작은 터치 영역 ${r.small.join(', ')}`);
  check(r.minFont >= 14, label, `${screen}: 너무 작은 글자 ${r.minFont}px "${r.minText}"`);
  return r;
}

async function inView(page, sel) {
  return page.$eval(sel, (el) => { const b = el.getBoundingClientRect(); return b.top >= 0 && b.bottom <= window.innerHeight + 1; });
}

async function runDevice(browser, engine, name, dev, save) {
  const label = `${engine}/${name}`;
  const opts = { viewport: dev.viewport, deviceScaleFactor: dev.deviceScaleFactor, hasTouch: true, locale: 'ko-KR', userAgent: dev.userAgent };
  if (engine !== 'firefox') opts.isMobile = dev.isMobile;
  const ctxA = await browser.newContext(opts);
  const ctxB = await browser.newContext(opts);
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const errors = [];
  for (const p of [A, B]) p.on('pageerror', (e) => errors.push(e.message));
  const shot = async (p, s, full = false) => { if (save) await p.screenshot({ path: path.join(OUT, `${name}_${s}.png`), fullPage: full }); };
  const info = {};

  await A.goto(BASE);
  await A.waitForSelector('#home:not(.hidden)');
  info.home = await audit(A, label, '홈');
  check(await inView(A, '#goJoin'), label, '홈: "방 참가하기" 버튼이 첫 화면에 안 보임');
  await shot(A, '01_home');
  await A.tap('#goCreate');
  await A.tap('#createName');
  await A.fill('#createName', '김야탑');
  await A.tap('#doCreate');
  await A.waitForSelector('#waiting:not(.hidden)');
  await A.waitForFunction(() => document.getElementById('waitQr').naturalWidth > 0 && document.getElementById('waitUrl').textContent.includes('join='));
  info.waiting = await audit(A, label, '대기실');
  check(await inView(A, '#waitQr'), label, '대기실: QR이 첫 화면에 다 안 보임');
  await shot(A, '02_waiting_qr');
  const code = (await A.textContent('#waitCode')).trim();

  await B.goto(BASE + '/?join=' + code);
  await B.waitForSelector('#join:not(.hidden)');
  check((await B.inputValue('#joinCode')) === code, label, 'QR 링크로 코드 자동 입력 안 됨');
  info.join = await audit(B, label, '참가');
  await B.tap('#joinName');
  await B.fill('#joinName', '이탑제');
  await B.tap('#doJoin');
  await A.waitForSelector('#play:not(.hidden)');
  await B.waitForSelector('#play:not(.hidden)');
  info.play = await audit(A, label, '선택');
  check(await inView(A, '.choice.D'), label, '선택: 협력/배신 버튼이 첫 화면에 다 안 보임');
  await shot(A, '03_choice');

  // 1라운드: A 협력(탭 → 확정), B 배신
  await A.tap('.choice.C');
  await A.waitForSelector('#confirmChoice:not(.hidden)');
  check(await inView(A, '#confirmChoice'), label, '선택: "결정!" 버튼이 스크롤 없이 안 보임');
  await shot(A, '04_choice_selected');
  await A.tap('#confirmChoice');
  await B.waitForFunction(() => document.getElementById('playStatus').textContent.includes('상대는 이미'));
  await B.tap('.choice.D');
  await B.tap('#confirmChoice');
  await A.waitForSelector('#result:not(.hidden)');
  await B.waitForSelector('#result:not(.hidden)');
  info.result = await audit(A, label, '라운드 완료 안내');
  check(await inView(A, '#resMsg'), label, '안내: "다음 라운드로" 문구가 첫 화면에 안 보임');
  check((await A.textContent('#resMsg')).includes('다음 라운드'), label, '안내 화면에 선택·사탕 결과가 보임');
  await shot(A, '05_round_result');
  await A.waitForSelector('#play:not(.hidden)');
  await B.waitForSelector('#play:not(.hidden)');

  // 2라운드: B가 고른 뒤 새로고침
  await B.waitForSelector('#play:not(.hidden)');
  await B.tap('.choice.C');
  await B.tap('#confirmChoice');
  await B.waitForFunction(() => document.getElementById('playStatus').textContent.includes('선택 완료'));
  await B.reload();
  await B.waitForSelector('#play:not(.hidden)');
  await B.waitForFunction(() => document.getElementById('playStatus').textContent.includes('선택 완료'));
  check((await B.textContent('#roundNo')).trim() === '2', label, '새로고침 후 2라운드로 복귀 실패');

  // 태블릿이 잠들었다 깬 상황: A의 연결을 끊고(자동 재연결 없음) 화면이 다시 보일 때 복귀하는지
  await A.waitForSelector('#play:not(.hidden)');
  await A.evaluate(() => window.__pdSocket.disconnect());
  await B.waitForFunction(() => document.getElementById('oppConn').textContent.includes('연결 끊김'));
  await A.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await A.waitForFunction(() => window.__pdSocket.connected, null, { timeout: 8000 });
  await B.waitForFunction(() => document.getElementById('oppConn').textContent.includes('접속 중'));
  await A.waitForFunction(() => document.getElementById('playStatus').textContent.includes('상대는 이미'));
  // A가 고르기
  await A.tap('.choice.C');
  await A.tap('#confirmChoice');
  await A.waitForSelector('#result:not(.hidden)');
  await B.waitForSelector('#result:not(.hidden)');
  await A.waitForSelector('#play:not(.hidden)');
  await B.waitForSelector('#play:not(.hidden)');

  const play = async (a, b) => {
    for (const [p, c] of [[A, a], [B, b]]) {
      await p.waitForSelector('#play:not(.hidden)');
      await p.tap('.choice.' + c);
      await p.tap('#confirmChoice');
    }
    await A.waitForSelector('#result:not(.hidden)');
    await B.waitForSelector('#result:not(.hidden)');
    await A.waitForSelector('#play:not(.hidden), #final:not(.hidden)');
    await B.waitForSelector('#play:not(.hidden), #final:not(.hidden)');
  };
  await play('D', 'C');
  await play('D', 'D');
  await play('C', 'C');
  await A.waitForSelector('#final:not(.hidden)');
  await B.waitForSelector('#final:not(.hidden)');
  const totals = await A.$$eval('#finalTotals .num', (els) => els.map((e) => e.textContent).join(','));
  check(totals === '12,12', label, '최종 합계 틀림 ' + totals);
  info.final = await audit(A, label, '최종');
  check(await inView(A, '#finalTotals'), label, '최종: 사탕 합계가 첫 화면에 안 보임');
  await shot(A, '06_final');
  await shot(B, '06_final_full', true);
  await B.reload();
  await B.waitForSelector('#final:not(.hidden)');

  // 모니터 / 관리자
  const M = await ctxA.newPage();
  M.on('pageerror', (e) => errors.push(e.message));
  await M.goto(BASE + '/monitor');
  await M.waitForFunction(() => Number(document.getElementById('sRounds').textContent) > 0);
  await M.waitForTimeout(900);
  info.monitor = await audit(M, label, '모니터');
  await shot(M, '07_monitor');
  const AD = await ctxB.newPage();
  AD.on('pageerror', (e) => errors.push(e.message));
  await AD.goto(BASE + '/admin');
  await AD.tap('#pin');
  await AD.fill('#pin', '1234');
  await AD.tap('#doLogin');
  await AD.waitForSelector('#panel:not(.hidden)');
  await AD.waitForFunction(() => document.querySelectorAll('#rooms tr').length > 1);
  info.admin = await audit(AD, label, '관리자');
  await shot(AD, '08_admin', true);

  check(errors.length === 0, label, '자바스크립트 오류: ' + errors.join(' | '));
  await ctxA.close();
  await ctxB.close();
  const s = (k) => `${k}:${info[k].wrapW}/${info[k].vw}w,font>=${info[k].minFont}`;
  console.log(`  ✔ ${label} (${info.home.vw}x${info.home.vh}) 전체 흐름 완료 · ${['play', 'result', 'final', 'monitor'].map(s).join(' · ')}`);
}

// 사파리 개인정보 보호 모드처럼 저장소가 막힌 경우에도 게임이 되는지
async function runStorageBlocked(browser, engine) {
  const label = `${engine}/저장소-차단(개인정보보호 모드 흉내)`;
  const dev = D['iPad (gen 7)'];
  const opts = { viewport: dev.viewport, hasTouch: true, locale: 'ko-KR', userAgent: dev.userAgent };
  const block = () => {
    const thrower = () => { throw new DOMException('blocked', 'QuotaExceededError'); };
    Storage.prototype.setItem = thrower;
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } });
  };
  const ctxA = await browser.newContext(opts);
  const ctxB = await browser.newContext(opts);
  await ctxA.addInitScript(block);
  await ctxB.addInitScript(block);
  const A = await ctxA.newPage(), B = await ctxB.newPage();
  const errors = [];
  for (const p of [A, B]) p.on('pageerror', (e) => errors.push(e.message));
  try {
    await A.goto(BASE);
    await A.tap('#goCreate');
    await A.tap('#doCreate');
    await A.waitForSelector('#waiting:not(.hidden)');
    const code = (await A.textContent('#waitCode')).trim();
    await B.goto(BASE + '/?join=' + code);
    await B.tap('#doJoin');
    for (let r = 0; r < 5; r++) {
      for (const p of [A, B]) { await p.waitForSelector('#play:not(.hidden)'); await p.tap('.choice.C'); await p.tap('#confirmChoice'); }
      if (r < 4) {
        await A.waitForSelector('#result:not(.hidden)');
        await A.waitForSelector('#play:not(.hidden)');
      }
    }
    await A.waitForSelector('#final:not(.hidden)');
    const totals = await A.$$eval('#finalTotals .num', (els) => els.map((e) => e.textContent).join(','));
    check(totals === '15,15', label, '합계 틀림 ' + totals);
    check(errors.length === 0, label, 'JS 오류 ' + errors.join(' | '));
    console.log(`  ✔ ${label}: 저장소 없이도 5라운드 완료 (${totals}) — 단, 이 경우 새로고침하면 자리 복귀는 안 됨`);
  } catch (e) {
    check(false, label, '흐름 중단 - ' + e.message.split('\n')[0]);
  }
  await ctxA.close(); await ctxB.close();
}

(async () => {
  for (const engine of ENGINES) {
    let browser;
    try {
      browser = engine === 'chromium' ? await pw.chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] }) : await pw[engine].launch();
    } catch (e) {
      console.log(`⚠ ${engine} 실행 불가: ${e.message.split('\n')[0]}`);
      continue;
    }
    console.log(`\n[${engine} ${browser.version()}]`);
    await runStorageBlocked(browser, engine);
    for (const [name, dev, save] of DEVICES) {
      if (engine === 'firefox' && !FIREFOX_DEVICES.includes(name)) continue;
      try {
        await runDevice(browser, engine, name, dev, save && engine === 'chromium');
      } catch (e) {
        fails++;
        problems.push(`${engine}/${name}: 흐름 중단 - ${e.message.split('\n')[0]}`);
        console.log(`  ✘ ${engine}/${name}: 흐름 중단 - ${e.message.split('\n')[0]}`);
      }
    }
    await browser.close();
  }
  console.log(fails ? `\n문제 ${fails}개:\n- ` + problems.join('\n- ') : '\n태블릿 테스트 모두 통과');
  process.exit(fails ? 1 : 0);
})();
