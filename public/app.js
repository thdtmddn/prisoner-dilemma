(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const { esc, CHOICE_TEXT, CHOICE_EMOJI } = window.PD;
  const KEY = 'pd_session';

  // ---- 저장소: 사파리 개인정보 보호 모드 등에서 막혀도 메모리로 대신 동작 ----
  const memStore = {};
  function store(kind) {
    let st = null;
    try {
      st = window[kind];
      const t = '__pd_test__';
      st.setItem(t, '1');
      st.removeItem(t);
    } catch (e) {
      st = null;
    }
    return {
      get(k) { try { if (st) return st.getItem(k); } catch (e) {} return Object.prototype.hasOwnProperty.call(memStore, kind + k) ? memStore[kind + k] : null; },
      set(k, v) { memStore[kind + k] = v; try { if (st) st.setItem(k, v); } catch (e) {} },
      del(k) { delete memStore[kind + k]; try { if (st) st.removeItem(k); } catch (e) {} },
    };
  }
  const SS = store('sessionStorage');
  const LS = store('localStorage');

  // ---- 세션 저장: 탭별(sessionStorage) 우선, 없으면 localStorage ----
  function getSession() {
    try {
      const s = SS.get(KEY) || LS.get(KEY);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }
  function setSession(s) {
    const v = JSON.stringify(s);
    SS.set(KEY, v);
    LS.set(KEY, v);
  }
  function clearSession() {
    SS.del(KEY);
    LS.del(KEY);
  }
  function seenKey(code) { return 'pd_seen_' + code; }
  function getSeen(code) { return Number(LS.get(seenKey(code)) || 0); }
  function setSeen(code, n) { LS.set(seenKey(code), String(n)); }

  let view = null;      // 서버가 보내준 현재 상태
  let pending = null;   // 아직 확정하지 않은 선택
  let info = { payoff: { CC: 3, CD: 0, DC: 5, DD: 1 }, rounds: 5 };

  // ---- 화면 전환 ----
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== id));
    window.scrollTo(0, 0);
    document.body.dataset.screen = id;
  }
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
  }
  function fillPayoff(p, rounds) {
    document.querySelectorAll('.js-payoff').forEach((el) => (el.innerHTML = window.PD.payoffTable(p)));
    document.querySelectorAll('.js-rounds, .js-total').forEach((el) => (el.textContent = rounds));
  }

  // ---- 소켓 ----
  const socket = io({ transports: ['websocket', 'polling'] });
  window.__pdSocket = socket; // 테스트용
  function resumeNow(onAck) {
    const s = getSession();
    if (!s) return onAck && onAck(true);
    socket.emit('resume', s, (res) => {
      if (onAck) onAck(true);
      if (!res || !res.ok) {
        clearSession();
        view = null;
        toast('이전 게임이 끝났거나 없어졌어요.');
        route();
      }
    });
  }
  socket.on('connect', () => {
    $('connBanner').classList.add('hidden');
    resumeNow();
  });

  // 태블릿이 잠들었다 깨거나(화면 꺼짐), 다른 앱에 갔다 오거나, 와이파이가 다시 잡히면
  // 연결을 확인하고 같은 자리로 다시 들어간다.
  let wakeTimer = null;
  function onWake() {
    if (document.visibilityState === 'hidden') return;
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      if (!socket.connected) {
        socket.connect();
        return;
      }
      // 연결된 것처럼 보여도 실제로는 끊겼을 수 있으니 응답을 확인한다
      let answered = false;
      resumeNow(() => (answered = true));
      setTimeout(() => {
        if (!answered) {
          socket.disconnect();
          socket.connect();
        }
      }, 4000);
    }, 150);
  }
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('pageshow', onWake);
  window.addEventListener('focus', onWake);
  window.addEventListener('online', onWake);
  socket.on('disconnect', () => $('connBanner').classList.remove('hidden'));
  let lastState = null; // 세션 저장 전에 도착한 상태(방 만들기/참가 직후)
  socket.on('state', (v) => {
    lastState = v;
    const s = getSession();
    if (!s || s.code !== v.code) return;
    view = v;
    render();
  });
  socket.on('room-closed', () => {
    clearSession();
    view = null;
    toast('관리자가 방을 닫았어요.');
    route();
  });

  // ---- 초기 라우팅 ----
  function route() {
    const params = new URLSearchParams(location.search);
    const joinCode = (params.get('join') || '').replace(/\D/g, '');
    const s = getSession();
    if (joinCode && (!s || s.code !== joinCode)) {
      // QR로 새 방에 들어온 경우
      if (s) clearSession();
      view = null;
      $('joinCode').value = joinCode;
      show('join');
      return;
    }
    if (s) {
      if (view) render();
      else show('loading'); // 서버 응답(state)이 오면 게임 화면으로 바뀜
      return;
    }
    show('home');
  }

  // ---- 상태에 맞게 그리기 ----
  function render() {
    if (!view) return;
    const v = view;
    const me = v.seat;
    const other = 1 - me;
    fillPayoff(v.payoff, v.totalRounds);
    document.querySelectorAll('.js-code').forEach((el) => (el.textContent = v.code));

    if (v.status === 'waiting') {
      $('waitCode').textContent = v.code;
      const qrSrc = '/api/qr.svg?code=' + v.code;
      if ($('waitQr').getAttribute('src') !== qrSrc) $('waitQr').src = qrSrc;
      fetch('/api/info').then((r) => r.json()).then((i) => ($('waitUrl').textContent = i.baseUrl + '/?join=' + v.code)).catch(() => {});
      show('waiting');
      return;
    }

    const seen = getSeen(v.code);
    if (seen < v.history.length) {
      renderResult(v, v.history[v.history.length - 1]);
      return;
    }
    if (v.status === 'finished') {
      renderFinal(v);
      return;
    }
    renderPlay(v, me, other);
  }

  function renderPlay(v, me, other) {
    const opp = v.players[other];
    $('roundNo').textContent = v.round;
    $('myTotal').textContent = v.totals[me];
    $('meName').textContent = (v.players[me] && v.players[me].name) || '나';
    $('oppDot').className = 'dot ' + (opp && opp.connected ? 'on' : 'off');
    $('oppConn').textContent = opp ? `상대 ${opp.name} · ${opp.connected ? '접속 중' : '연결 끊김'}` : '상대 없음';

    const chosen = v.myChoice;
    document.querySelectorAll('.choice').forEach((b) => {
      const c = b.dataset.choice;
      b.disabled = !!chosen;
      b.classList.toggle('picked', (chosen || pending) === c);
      if (chosen && chosen === c) b.disabled = false;
    });
    $('confirmChoice').classList.toggle('hidden', !!chosen || !pending);
    if (pending && !chosen) {
      $('confirmChoice').textContent = `${CHOICE_EMOJI[pending]} ${CHOICE_TEXT[pending]}(으)로 결정!`;
      $('confirmChoice').style.background = pending === 'C' ? 'var(--coop)' : 'var(--betray)';
    }

    const st = $('playStatus');
    if (chosen) {
      st.className = 'status ok';
      st.textContent = v.opponentChosen ? '둘 다 골랐어요! 결과 계산 중…' : `✅ 선택 완료! 상대가 고르는 중이에요… 🤔`;
    } else {
      st.className = 'status' + (opp && !opp.connected ? ' warn' : '');
      if (opp && !opp.connected) st.textContent = '상대 연결이 끊겼어요. 잠깐 기다려 주세요.';
      else st.textContent = v.opponentChosen ? '상대는 이미 골랐어요! 이제 내 차례 👉' : '협력할까, 배신할까? 골라 주세요!';
    }
    show('play');
  }

  function renderResult(v, h) {
    const me = v.seat, other = 1 - me;
    const myC = h.choices[me], opC = h.choices[other];
    const box = (who, c, gain) =>
      `<div class="result-box ${c}"><div class="who">${esc(who)}</div><div class="what">${CHOICE_EMOJI[c]} ${CHOICE_TEXT[c]}</div><div class="gain">+${gain}🍬</div></div>`;
    $('resRound').textContent = h.round;
    $('resGrid').innerHTML =
      box('나 (' + ((v.players[me] && v.players[me].name) || '') + ')', myC, h.candies[me]) +
      box('상대 (' + ((v.players[other] && v.players[other].name) || '') + ')', opC, h.candies[other]);
    let msg;
    if (myC === 'C' && opC === 'C') msg = '둘 다 협력했어요! 🤝 사이좋게 나눠요.';
    else if (myC === 'D' && opC === 'D') msg = '둘 다 배신했어요… 😈😈';
    else if (myC === 'D') msg = '내가 배신했어요! 😈 상대는 협력했는데…';
    else msg = '상대가 배신했어요… 😢';
    $('resMsg').textContent = msg;
    const myTotal = v.history.slice(0, h.round).reduce((a, x) => a + x.candies[me], 0);
    $('resTotal').textContent = myTotal;
    const last = v.history.length >= v.totalRounds;
    $('nextRound').textContent = last ? '최종 결과 보기 🍬' : '다음 라운드 ▶';
    show('result');
  }

  function renderFinal(v) {
    const me = v.seat;
    const name = (i) => esc((v.players[i] && v.players[i].name) || `플레이어 ${i + 1}`);
    $('finalTotals').innerHTML = [0, 1]
      .map((i) => `<div class="final-box ${i === me ? 'me' : ''}"><div class="name">${name(i)}${i === me ? ' (나)' : ''}</div><div class="num">${v.totals[i]}</div><div class="unit">개 🍬</div></div>`)
      .join('');
    const cell = (c, n) => `<td class="${c}">${CHOICE_EMOJI[c]} ${CHOICE_TEXT[c]} <b>+${n}</b></td>`;
    $('finalHistory').innerHTML =
      `<thead><tr><th>라운드</th><th>${name(0)}</th><th>${name(1)}</th></tr></thead><tbody>` +
      v.history.map((h) => `<tr><td>${h.round}</td>${cell(h.choices[0], h.candies[0])}${cell(h.choices[1], h.candies[1])}</tr>`).join('') +
      `</tbody><tfoot><tr><td>합계</td><td>${v.totals[0]}개</td><td>${v.totals[1]}개</td></tr></tfoot>`;
    show('final');
  }

  function adopt(code) {
    if (lastState && lastState.code === code) {
      view = lastState;
      render();
    } else {
      socket.emit('resume', getSession(), () => {});
    }
  }

  // ---- 버튼 ----
  document.querySelectorAll('.js-home').forEach((b) => b.addEventListener('click', () => { history.replaceState(null, '', '/'); show('home'); }));
  $('goCreate').onclick = () => show('create');
  $('goJoin').onclick = () => { show('join'); setTimeout(() => $('joinCode').focus(), 50); };

  let busy = false;
  $('doCreate').onclick = () => {
    if (busy) return;
    busy = true;
    socket.emit('create', { name: $('createName').value }, (res) => {
      busy = false;
      if (!res || !res.ok) return toast((res && res.error) || '방을 만들지 못했어요.');
      setSession({ code: res.code, token: res.token });
      setSeen(res.code, 0);
      history.replaceState(null, '', '/');
      adopt(res.code);
    });
  };
  $('doJoin').onclick = () => {
    const code = $('joinCode').value.replace(/\D/g, '');
    if (code.length < 4) return toast('방 코드 4자리를 넣어 주세요.');
    if (busy) return;
    busy = true;
    socket.emit('join', { code, name: $('joinName').value }, (res) => {
      busy = false;
      if (!res || !res.ok) return toast((res && res.error) || '참가하지 못했어요.');
      setSession({ code: res.code, token: res.token });
      setSeen(res.code, 0);
      history.replaceState(null, '', '/');
      adopt(res.code);
    });
  };
  $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('doJoin').click(); });
  $('cancelWait').onclick = () => {
    socket.emit('leave', {}, () => {});
    clearSession();
    view = null;
    show('home');
  };

  document.querySelectorAll('.choice').forEach((b) =>
    b.addEventListener('click', () => {
      if (!view || view.myChoice) return;
      pending = b.dataset.choice;
      render();
    })
  );
  $('confirmChoice').onclick = () => {
    if (!pending || !view) return;
    const c = pending;
    $('confirmChoice').disabled = true;
    socket.emit('choose', { choice: c }, (res) => {
      $('confirmChoice').disabled = false;
      pending = null;
      if (!res || !res.ok) toast((res && res.error) || '선택을 보내지 못했어요.');
      render();
    });
  };
  $('nextRound').onclick = () => {
    if (!view) return;
    setSeen(view.code, view.history.length);
    pending = null;
    render();
  };
  $('newGame').onclick = () => {
    socket.emit('leave', {}, () => {});
    clearSession();
    view = null;
    history.replaceState(null, '', '/');
    show('home');
  };

  // ---- 시작 ----
  fetch('/api/info').then((r) => r.json()).then((i) => {
    info = i;
    if (!view) fillPayoff(i.payoff, i.rounds);
  }).catch(() => {});
  fillPayoff(info.payoff, info.rounds);
  route();
})();
