// 실제 브라우저(헤드리스 크롬)로 화면을 눌러 보며 테스트하고 스크린샷을 저장합니다.
// 사용법: 서버를 켠 상태에서  BASE=http://localhost:3000 node test/screenshots.js
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'screenshots');
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
fs.mkdirSync(OUT, { recursive: true });

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' };
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none'] });
  const ctxA = await browser.newContext(phone);
  const ctxB = await browser.newContext(phone);
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const shot = (p, name, full = true) => p.screenshot({ path: path.join(OUT, name), fullPage: full });
  const visible = (p, id) => p.locator('#' + id).isVisible();

  await A.goto(BASE);
  await A.waitForSelector('#home:not(.hidden)');
  await shot(A, '01_home.png');

  await A.click('#goCreate');
  await A.fill('#createName', '김야탑');
  await A.click('#doCreate');
  await A.waitForSelector('#waiting:not(.hidden)');
  await A.waitForFunction(() => document.getElementById('waitQr').complete && document.getElementById('waitQr').naturalWidth > 0);
  await A.waitForFunction(() => document.getElementById('waitUrl').textContent.includes('join='));
  const code = (await A.textContent('#waitCode')).trim();
  check(/^\d{4}$/.test(code), '방 코드 화면 + QR 표시 (' + code + ')');
  await shot(A, '02_room_code_qr.png');
  const joinUrl = (await A.textContent('#waitUrl')).trim();
  console.log('    QR 주소:', joinUrl);

  // QR로 들어온 것처럼 ?join=코드
  await B.goto(BASE + '/?join=' + code);
  await B.waitForSelector('#join:not(.hidden)');
  check((await B.inputValue('#joinCode')) === code, 'QR 주소로 열면 방 코드가 자동 입력');
  await B.fill('#joinName', '이탑제');
  await shot(B, '03_join.png');
  await B.click('#doJoin');
  await A.waitForSelector('#play:not(.hidden)');
  await B.waitForSelector('#play:not(.hidden)');
  check(true, '참가하면 두 화면 모두 게임 시작');
  check((await A.textContent('#oppConn')).includes('이탑제') && (await A.textContent('#oppConn')).includes('접속 중'), '상대 이름·접속 상태 표시');
  await shot(A, '04_choice.png');

  // 1라운드: A 협력, B 배신
  await A.click('.choice.C');
  await A.waitForSelector('#confirmChoice:not(.hidden)');
  await shot(A, '05_choice_selected.png', false);
  await A.click('#confirmChoice');
  await A.waitForFunction(() => document.getElementById('playStatus').textContent.includes('선택 완료'));
  await B.waitForFunction(() => document.getElementById('playStatus').textContent.includes('상대는 이미 골랐어요'));
  check(true, 'A가 고르면 B에게는 "상대는 이미 골랐어요"만 보임');
  await shot(A, '06_waiting_opponent.png', false);
  await B.click('.choice.D');
  await B.click('#confirmChoice');
  await A.waitForSelector('#result:not(.hidden)');
  await B.waitForSelector('#result:not(.hidden)');
  check((await A.textContent('#resRound')).trim() === '1', '1라운드 완료 안내');
  check((await A.textContent('#resMsg')).includes('다음 라운드'), '선택·사탕 결과 없이 다음 라운드 안내만');
  await shot(A, '07_round_result.png');
  await A.waitForSelector('#play:not(.hidden)');
  await B.waitForSelector('#play:not(.hidden)');
  check((await A.textContent('#roundNo')).trim() === '2', '안내 후 자동으로 2라운드');

  const play = async (a, b) => {
    for (const [p, c] of [[A, a], [B, b]]) {
      await p.waitForSelector('#play:not(.hidden)');
      await p.click('.choice.' + c);
      await p.click('#confirmChoice');
    }
    await A.waitForSelector('#result:not(.hidden)');
    await B.waitForSelector('#result:not(.hidden)');
    await A.waitForSelector('#play:not(.hidden)');
    await B.waitForSelector('#play:not(.hidden)');
  };
  // 2라운드: B가 고른 뒤 새로고침
  await A.waitForSelector('#play:not(.hidden)');
  await B.click('.choice.C');
  await B.click('#confirmChoice');
  await B.waitForFunction(() => document.getElementById('playStatus').textContent.includes('선택 완료'));
  await B.reload();
  await B.waitForSelector('#play:not(.hidden)');
  await B.waitForFunction(() => document.getElementById('playStatus').textContent.includes('선택 완료'));
  check((await B.textContent('#roundNo')).trim() === '2', '새로고침해도 같은 방·2라운드·내 선택 유지');
  await A.click('.choice.C');
  await A.click('#confirmChoice');
  await A.waitForSelector('#result:not(.hidden)');
  await B.waitForSelector('#result:not(.hidden)');
  await A.waitForSelector('#play:not(.hidden)');
  await B.waitForSelector('#play:not(.hidden)');
  await play('D', 'C'); // 3라운드
  await play('D', 'D'); // 4라운드
  // 5라운드
  for (const [p, c] of [[A, 'C'], [B, 'C']]) { await p.waitForSelector('#play:not(.hidden)'); await p.click('.choice.' + c); await p.click('#confirmChoice'); }
  await A.waitForSelector('#result:not(.hidden)');
  check((await A.textContent('#resMsg')).includes('끝났어요'), '마지막 라운드 뒤 종료 안내');
  await A.waitForSelector('#final:not(.hidden)');
  await B.waitForSelector('#final:not(.hidden)');
  const totals = await A.$$eval('#finalTotals .num', (els) => els.map((e) => e.textContent));
  // A: 0+3+5+1+3 = 12, B: 5+3+0+1+3 = 12
  check(totals.join(',') === '12,12', '최종 합계 표시 ' + totals.join(','));
  await shot(A, '08_final.png');
  await B.reload();
  await B.waitForSelector('#final:not(.hidden)');
  check(true, '끝난 뒤 새로고침해도 최종 화면 유지');

  // 모니터 (노트북/모니터 크기)
  const ctxM = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'ko-KR' });
  const M = await ctxM.newPage();
  await M.goto(BASE + '/monitor');
  await M.waitForFunction(() => Number(document.getElementById('sRounds').textContent) > 0);
  await M.waitForTimeout(1000);
  await M.screenshot({ path: path.join(OUT, '09_monitor.png') });
  await M.setViewportSize({ width: 1920, height: 1080 });
  await M.waitForTimeout(900);
  await M.screenshot({ path: path.join(OUT, '09b_monitor_1080p.png') });
  const Mp = await browser.newContext(phone).then((c) => c.newPage());
  await Mp.goto(BASE + '/monitor');
  await Mp.waitForFunction(() => Number(document.getElementById('sRounds').textContent) > 0);
  await Mp.waitForTimeout(1000);
  await Mp.screenshot({ path: path.join(OUT, '10_monitor_phone.png'), fullPage: true });
  check(true, '모니터 화면 표시');

  // 관리자
  const AD = await browser.newContext(phone).then((c) => c.newPage());
  await AD.goto(BASE + '/admin');
  await AD.fill('#pin', process.env.PIN || '1234');
  await AD.click('#doLogin');
  await AD.waitForSelector('#panel:not(.hidden)');
  await AD.waitForFunction(() => document.getElementById('pCC').value !== '');
  await AD.waitForTimeout(500);
  await AD.screenshot({ path: path.join(OUT, '11_admin.png'), fullPage: true });
  check(true, '관리자 화면 로그인');

  await browser.close();
  console.log(fails ? `실패 ${fails}개` : '브라우저 테스트 모두 통과');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
