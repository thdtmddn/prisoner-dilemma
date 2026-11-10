// 공통: 보상표 그리기 등
window.PD = {
  CHOICE_TEXT: { C: '협력', D: '배신' },
  CHOICE_EMOJI: { C: '🤝', D: '😈' },
  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  payoffTable(p, opts = {}) {
    const me = opts.me || '나';
    const other = opts.other || '상대';
    const cell = opts.compact
      ? (a, b) => `<span style="font-size:1.4em"><b>${p[a + b]}</b> : <b>${p[b + a]}</b></span>`
      : (a, b) => `<div>${me} <b>${p[a + b]}</b>개</div><div>${other} <b>${p[b + a]}</b>개</div>`;
    return `<div class="payoff-title">🍬 사탕 보상표</div>
<table class="payoff">
  <tr><th></th><th>${other} <span class="c">🤝협력</span></th><th>${other} <span class="d">😈배신</span></th></tr>
  <tr><th>${me} <span class="c">🤝협력</span></th><td>${cell('C', 'C')}</td><td>${cell('C', 'D')}</td></tr>
  <tr><th>${me} <span class="d">😈배신</span></th><td>${cell('D', 'C')}</td><td>${cell('D', 'D')}</td></tr>
</table>`;
  },
};
