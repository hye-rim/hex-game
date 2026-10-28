'use strict';
// 오락실 튜토리얼이 '진짜로 일어난 일'을 알아채는 신호 (arcade/public/tutorial.js 가 듣는다. 튜토리얼이 아니면 아무도 안 듣는다)
const tutorialSignal = (type) => window.dispatchEvent(new CustomEvent('arcade:tutorial', { detail: { type } }));

// 헥스: 화면·입력·소리·온라인. 규칙과 컴퓨터는 logic.js (LOGIC_HEX), 방·매칭은 server.js
(() => {
const L = LOGIC_HEX;
const $ = (id) => document.getElementById(id);
const T = { cpu: 600, over: 900, banner: 1100 };                    // 시간(ms). 시험용으로 줄일 수 있다
const SIDE_NAME = ['분홍', '노랑'];
const ROLE = ['위·아래 잇기', '왼쪽·오른쪽 잇기'];
const SVGNS = 'http://www.w3.org/2000/svg';

// ---------- 저장소 ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};
let wins = Number(store.get('hexWins')) || 0;
const ONLINE_KEY = 'hexOnline', SESSION_KEY = 'hexSession';
const loadJson = (k) => { try { return JSON.parse(store.get(k)) || {}; } catch (_) { return {}; } };
function loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (_) { return null; } }
function saveSession(s) { try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch (_) {} }
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const myName = () => store.get('hexName') || '';
// 판 크기·스왑 규칙 (컴퓨터 대전과 방 만들기에 쓴다)
let setSize = L.SIZES.includes(Number(store.get('hexSize'))) ? Number(store.get('hexSize')) : 9;
let setSwap = store.get('hexSwap') !== '0';

// ---------- 소리 ----------
let audio = null;
let muted = store.get('hexMuted') === '1';
function tone(freq, dur, type = 'sine', vol = 0.09, slide = 0) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + dur);
  } catch (_) {}
}
const seq = (notes, step, type = 'triangle', vol = 0.09) => notes.forEach((f, i) => setTimeout(() => tone(f, step * 0.0009, type, vol), i * step));
const sfx = {
  ghost: () => tone(640, 0.04, 'triangle', 0.06),
  mine: () => tone(330, 0.08, 'square', 0.07, -80),
  theirs: () => tone(250, 0.08, 'square', 0.06, -60),
  swap: () => seq([500, 380, 600], 90, 'triangle', 0.08),
  bad: () => tone(150, 0.1, 'square', 0.05),
  found: () => seq([392, 523], 90, 'triangle', 0.08),
  win: () => seq([523, 659, 784, 1047], 110, 'triangle', 0.1),
  lose: () => seq([392, 330, 262, 196], 150, 'sawtooth', 0.06),
};
function toggleMute() { muted = !muted; store.set('hexMuted', muted ? '1' : '0'); $('muteBtn').textContent = muted ? '🔇' : '🔊'; }
$('muteBtn').onclick = (e) => { e.currentTarget.blur(); toggleMute(); };
$('muteBtn').textContent = muted ? '🔇' : '🔊';

// ---------- 상태 ----------
let mode = 'easy';                  // 'easy' · 'hard' (컴퓨터) · 'online'
let phase = 'title';                // title · play · over
let st = null;                      // 컴퓨터 대전 판
let cpuYou = 0;                     // 컴퓨터 대전에서 내 자리 (0 먼저, 1 나중). 다시 하면 서로 바뀐다
let room = null, view = null, waitingNet = false, netDown = false, turnEnd = 0, recorded = '', seenMove = 0;
let cpuTimer = 0, overTimer = 0, thinking = false, bannerTimer = 0;
let ghost = -1;                     // 터치로 고른(아직 안 놓은) 칸
let lastCell = -1;                  // 방금 놓은 돌
const online = () => mode === 'online';

// 화면이 쓰는 모양으로: { v: { n, board, turn, canSwap, path }, you, state, winner, reason, names }
function model() {
  if (online()) {
    if (!room || !view) return null;
    return { v: view, you: room.you, state: room.state, winner: room.winner, reason: room.reason,
      names: [0, 1].map((c) => (c === room.you ? '나' : ((room.players.find((p) => p.color === c) || {}).name || '상대'))) };
  }
  if (!st) return null;
  const mine = st.turn === cpuYou && !st.over;
  return { v: { n: st.n, board: st.board, turn: st.turn, canSwap: mine && L.canSwap(st), path: st.path },
    you: cpuYou, state: st.over ? 'over' : 'playing', winner: st.winner, reason: st.reason, names: cpuYou === 0 ? ['나', '컴퓨터'] : ['컴퓨터', '나'] };
}
const viewFromRoom = (r) => ({ n: r.n, board: r.board, turn: r.turn, canSwap: !!r.canSwap, path: r.path || [] });
const myTurn = (m) => !!m && m.state === 'playing' && m.v.turn === m.you && !netDown && !thinking;
const canAct = (m) => myTurn(m) && !waitingNet;

// ---------- 판 그리기 ----------
const board = $('bwrap');
let geo = null;                                       // { n, s, w, W, H, x(r,c), y(r) }
const sv = (tag, attrs, parent) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
function makeGeo(n) {
  const s = 10, w = Math.sqrt(3) * s, pad = 9;
  return { n, s, w, pad,
    W: 2 * pad + w * (1.5 * (n - 1) + 1), H: 2 * pad + 2 * s + (n - 1) * 1.5 * s,
    x: (r, c) => pad + w / 2 + c * w + r * w / 2, y: (r) => pad + s + r * 1.5 * s };
}
const hexPts = (g, r, c, k = 1) => {
  const x = g.x(r, c), y = g.y(r), a = (g.w / 2) * k, b = (g.s / 2) * k, s = g.s * k;
  return [[x, y - s], [x + a, y - b], [x + a, y + b], [x, y + s], [x - a, y + b], [x - a, y - b]];
};
function drawBoard(n) {
  geo = makeGeo(n);
  const g = geo, svg = $('bsvg');
  svg.setAttribute('viewBox', `0 0 ${g.W.toFixed(2)} ${g.H.toFixed(2)}`);
  board.style.aspectRatio = `${g.W.toFixed(2)} / ${g.H.toFixed(2)}`;
  svg.innerHTML = '';
  // 가장자리: 분홍은 위·아래, 노랑은 왼쪽·오른쪽 (그 색 사람이 이 두 변을 이어야 한다)
  const edge = (pts, color) => sv('polyline', { points: pts.map((p) => p.join(',')).join(' '), fill: 'none', stroke: color, 'stroke-width': 5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  const top = [], bottom = [], left = [], right = [];
  for (let c = 0; c < n; c++) { const p = hexPts(g, 0, c), q = hexPts(g, n - 1, c); top.push(p[5], p[0], p[1]); bottom.push(q[4], q[3], q[2]); }
  for (let r = 0; r < n; r++) { const p = hexPts(g, r, 0), q = hexPts(g, r, n - 1); left.push(p[5], p[4]); right.push(q[1], q[2]); }
  edge(top, '#ff5fa2'); edge(bottom, '#ff5fa2'); edge(left, '#ffd23f'); edge(right, '#ffd23f');
  const cells = sv('g', { id: 'cells' }, svg);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const el = sv('polygon', { points: hexPts(g, r, c, 1).map((p) => p.map((v) => v.toFixed(2)).join(',')).join(' '), class: 'cell', 'data-i': r * n + c }, cells);
    el.dataset.i = r * n + c;
  }
  sv('g', { id: 'stones' }, svg);
}

function render() {
  const m = model();
  if (!m) { renderHud(null); return; }
  const v = m.v, n = v.n;
  if (!geo || geo.n !== n) drawBoard(n);
  const mine = canAct(m);
  if (ghost >= 0 && (!mine || v.board[ghost])) ghost = -1;
  const g = geo, host = $('stones');
  host.innerHTML = '';
  const center = (i) => [g.x((i / n) | 0, i % n), g.y((i / n) | 0)];
  if (v.path && v.path.length > 1) {
    for (let k = 1; k < v.path.length; k++) { const [x1, y1] = center(v.path[k - 1]), [x2, y2] = center(v.path[k]); sv('line', { x1, y1, x2, y2, class: 'link' }, host); }
  }
  v.board.forEach((val, i) => {
    if (!val) return;
    const [x, y] = center(i);
    sv('circle', { cx: x, cy: y, r: g.s * 0.66, class: `stone s${val - 1}` }, host);
    if (i === lastCell) sv('circle', { cx: x, cy: y, r: g.s * 0.2, class: 'lastm' }, host);
  });
  if (ghost >= 0) { const [x, y] = center(ghost); sv('circle', { cx: x, cy: y, r: g.s * 0.66, class: `stone ghost s${m.you}` }, host); }
  if (v.path) for (const i of v.path) { const [x, y] = center(i); sv('circle', { cx: x, cy: y, r: g.s * 0.8, class: 'win' }, host); }
  // 위·아래 이름표
  const opp = 1 - m.you;
  const dist = (side) => L.distance(v.board, n, side);
  const need = (side) => { const d = dist(side); return m.state === 'playing' && d < 1e9 ? ` · ${d}개 필요` : ''; };
  $('capTop').innerHTML = `<span class="who s${opp}${m.state === 'playing' && v.turn === opp ? ' on' : ''}">${esc(m.names[opp])} (${SIDE_NAME[opp]})${need(opp)}</span><span class="role">${ROLE[opp]}</span>`;
  $('capBottom').innerHTML = `<span class="who s${m.you}${m.state === 'playing' && v.turn === m.you ? ' on' : ''}">${esc(m.names[m.you])} (${SIDE_NAME[m.you]})${need(m.you)}</span><span class="role">${ROLE[m.you]}</span>`;
  $('swapBtn').style.display = v.canSwap && mine ? '' : 'none';
  renderHud(m);
}
function renderHud(m = model()) {
  $('wins').textContent = wins.toLocaleString('ko-KR');
  let text = '헥스';
  if (m && phase === 'play' && m.state === 'playing') {
    const sec = Math.max(0, Math.ceil((turnEnd - performance.now()) / 1000));
    if (online() && netDown) text = '연결 다시 붙이는 중…';
    else if (m.v.turn === m.you) text = `내 차례${online() ? ` · ${sec}초` : ''}`;
    else text = online() ? `${m.names[m.v.turn]} 차례 · ${sec}초` : '컴퓨터 차례…';
  }
  $('turn').textContent = text;
  $('resignBtn').style.display = online() && room && room.state === 'playing' ? '' : 'none';
}
function say(t) { $('msg').textContent = t; }
function banner(text, color) {
  const b = $('banner');
  b.textContent = text; b.style.color = color || '#fff'; b.classList.add('show');
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => b.classList.remove('show'), T.banner);
}

// ---------- 창 ----------
const overlayOpen = () => !$('overlay').classList.contains('hidden');
function showOverlay(html) { $('overlay').innerHTML = html; $('overlay').classList.remove('hidden'); }
function hideOverlay() { $('overlay').classList.add('hidden'); }

// ---------- 입력 ----------
function cellOf(e) {
  const el = e.target && e.target.closest ? e.target.closest('polygon.cell') : null;
  return el ? Number(el.dataset.i) : -1;
}
board.addEventListener('pointerdown', (e) => {
  const m = model();
  if (!m || phase !== 'play') return;
  e.preventDefault();
  const i = cellOf(e);
  if (i < 0) return;
  if (!canAct(m)) return;
  if (m.v.board[i]) { sfx.bad(); return; }
  // 마우스는 바로 놓고, 손가락은 먼저 고른 칸을 보여 준 뒤 같은 칸을 한 번 더 누르면 놓는다 (육각형이 작아 잘못 누르기 쉬워서)
  if (e.pointerType === 'mouse' || ghost === i) { ghost = -1; dispatch({ type: 'place', cell: i }); return; }
  ghost = i; sfx.ghost(); render();
  say('이 자리에 놓으려면 같은 칸을 한 번 더 눌러요');
});
$('swapBtn').onclick = (e) => { e.currentTarget.blur(); const m = model(); if (canAct(m) && m.v.canSwap) dispatch({ type: 'swap' }); };
addEventListener('keydown', (e) => { if (e.code === 'KeyM') toggleMute(); if (e.code === 'Escape') { ghost = -1; render(); } });

// 내 동작 하나를 낸다 (컴퓨터 판은 바로 적용, 온라인은 서버로)
function dispatch(a) {
  const m = model();
  if (!canAct(m)) return;
  if (online()) { waitingNet = true; net.send('act', { action: a }); render(); return; }
  const ev = L.apply(st, a);
  if (!ev) return;
  afterMove(ev, true);
}
function afterMove(ev, mine) {
  lastCell = ev.type === 'place' ? ev.cell : ev.to;
  announce(ev);
  if (mine) tutorialSignal(ev.type === 'swap' ? 'swap' : 'place');
  render();
  if (!online()) {
    if (st.over) { overTimer = setTimeout(showOver, T.over); return; }
    if (st.turn !== cpuYou) scheduleCpu();
  }
}
function announce(ev) {
  const m = model();
  if (!m) return;
  const mine = ev.who === m.you;
  const nm = mine ? '내가' : (online() ? `${m.names[ev.who]}${/[가-힣]$/.test(m.names[ev.who]) ? (((m.names[ev.who].charCodeAt(m.names[ev.who].length - 1) - 0xAC00) % 28 === 0) ? '가' : '이') : '이(가)'}` : '컴퓨터가');
  let t;
  if (ev.type === 'swap') { sfx.swap(); t = mine ? '내가 첫 돌을 바꿔 가졌어요' : `${nm} 첫 돌을 바꿔 가졌어요`; banner('스왑!', '#ffd23f'); if (!mine) t += '\n이제 내 차례예요'; }
  else { (mine ? sfx.mine : sfx.theirs)(); t = mine ? '돌을 놓았어요' : `${nm} 돌을 놓았어요`; }
  if (!(ev.over)) {
    const dm = L.distance(m.v.board, m.v.n, m.you), dopp = L.distance(m.v.board, m.v.n, 1 - m.you);
    t += `\n두 변을 이으려면 나는 ${dm}개, 상대는 ${dopp}개 더 필요해요`;
  }
  say(t);
}

// ---------- 컴퓨터 대전 ----------
function startCpu(level, you = 0) {
  leaveOnline();
  clearTimeout(cpuTimer); clearTimeout(overTimer);
  mode = level; cpuYou = you; st = L.newGame(setSize, setSwap); phase = 'play'; ghost = -1; thinking = false; turnEnd = 0; lastCell = -1;
  hideOverlay(); drawBoard(st.n); render();
  const first = you === 0;
  say(`내 돌은 ${SIDE_NAME[you]}색이에요. ${ROLE[you]}를 이으면 이겨요\n${first ? '내가 먼저 놓아요' : '컴퓨터가 먼저 놓아요'}${setSwap ? ' (스왑 규칙 켬)' : ''}`);
  if (!first) scheduleCpu();
}
function scheduleCpu() { thinking = true; render(); cpuTimer = setTimeout(cpuTurn, T.cpu); }
function cpuTurn() {
  if (phase !== 'play' || !st || online() || st.over || st.turn === cpuYou) { thinking = false; render(); return; }
  const a = L.aiPick(st, mode === 'hard' ? 'hard' : 'easy');
  const ev = a && L.apply(st, a);
  thinking = false;
  if (!ev) { render(); return; }
  afterMove(ev, false);
}
function showOver() {
  phase = 'over';
  const youWon = st.winner === cpuYou;
  if (youWon) { wins++; store.set('hexWins', String(wins)); sfx.win(); } else sfx.lose();
  const next = 1 - cpuYou;
  showOverlay(`
    <h2>${youWon ? '이겼어요! 🎉' : '아쉬워요! 😵'}</h2>
    <p>${youWon ? '내가 먼저 두 변을 이었어요' : '컴퓨터가 두 변을 이었어요'}</p>
    <dl class="stats card2"><dt>놓은 돌</dt><dd>${st.stones}개</dd><dt>판 크기</dt><dd>${st.n}×${st.n}</dd></dl>
    <p>컴퓨터 상대 승리 <b>${wins}</b>번</p>
    <div class="col"><button data-act="again">다시 하기<small>이번엔 ${next === 0 ? '내가 먼저' : '컴퓨터가 먼저'} 놓아요</small></button><button class="sub" data-act="view">판 보기</button><button class="sub" data-act="home">처음으로</button></div>`);
  render();
}
function settingsHtml(note) {
  return `
    <div class="seg"><span class="lab">판 크기</span>${L.SIZES.map((n) => `<button data-act="size" data-n="${n}" class="${n === setSize ? 'on' : ''}">${n}줄</button>`).join('')}</div>
    <div class="seg"><span class="lab">스왑 규칙</span><button data-act="swapopt" data-v="1" class="${setSwap ? 'on' : ''}">켜기</button><button data-act="swapopt" data-v="0" class="${setSwap ? '' : 'on'}">끄기</button></div>
    ${note ? `<p style="font-size:12px">${note}</p>` : ''}`;
}
function showTitle() {
  leaveOnline();
  clearTimeout(cpuTimer); clearTimeout(overTimer);
  mode = 'easy'; phase = 'title'; st = L.newGame(setSize, setSwap); ghost = -1; thinking = false; lastCell = -1;
  drawBoard(st.n); say(''); render();
  const on = loadJson(ONLINE_KEY);
  showOverlay(`
    <h1>헥스</h1>
    <p>자기 색 <b>두 변</b>을 돌로 먼저 이으면 이겨요!</p>
    <div class="card2" style="font-size:13px">나는 <b>분홍</b>: 위↔아래 변 · 상대는 <b>노랑</b>: 왼쪽↔오른쪽 변<br>번갈아 빈 칸에 돌을 놓아요. <b>무승부는 없어요</b></div>
    ${settingsHtml('')}
    <div class="col"><button data-act="cpu" data-lv="easy">🤖 컴퓨터랑 · 쉬움</button><button class="sub" data-act="cpu" data-lv="hard">🤖 컴퓨터랑 · 어려움</button><button class="sub" data-act="online">🌐 온라인 대전${on.w || on.l ? ` · ${on.w || 0}승 ${on.l || 0}패` : ''}</button></div>`);
}

// ---------- 온라인: 연결 ----------
const net = {
  ws: null, pulse: null, outbox: [], retry: 0,
  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${location.pathname}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.raw('hello', { name: myName() });
      const s = loadSession();
      if (s) this.raw('resume', s);
      for (const [t, p] of this.outbox.splice(0)) this.raw(t, p);
      clearInterval(this.pulse);
      this.pulse = setInterval(() => this.raw('pulse'), 10000);
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onNet(m); };
    ws.onclose = () => {
      clearInterval(this.pulse);
      if (this.ws !== ws) return;
      this.ws = null;
      if (!online()) return;
      if (room || loadSession()) {
        netDown = true; waitingNet = false; render();
        setTimeout(() => { if (online()) this.connect(); }, Math.min(4000, 500 * 2 ** this.retry++));
      } else showOnline('서버와 연결이 끊겼어요. 다시 시도해 주세요.');
    };
  },
  send(t, p = {}) {
    if (this.ws && this.ws.readyState === 1) this.raw(t, p);
    else { this.outbox.push([t, p]); this.connect(); }
  },
  raw(t, p = {}) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t, ...p })); },
  close() {
    const ws = this.ws;
    this.ws = null; this.outbox = [];
    clearInterval(this.pulse);
    if (ws) ws.close();
  },
};

function onNet(m) {
  if (m.t === 'queued') showQueued();
  else if (m.t === 'room') applyRoom(m);
  else if (m.t === 'rejected') { waitingNet = false; render(); }
  else if (m.t === 'error') { room = null; saveSession(null); showOnline(m.msg); }
  else if (m.t === 'resumeFailed') {
    saveSession(null);
    if (room) { room = null; showOnline('대국이 끝나서 이어갈 수 없어요.'); }
    netDown = false; render();
  }
}

function leaveOnline() {
  if (!online()) return;
  net.send('leave'); net.close();
  saveSession(null);
  room = null; view = null; netDown = false; waitingNet = false; mode = 'easy'; phase = 'title'; ghost = -1;
}

// ---------- 온라인: 대국 ----------
function applyRoom(r) {
  const prev = room;
  const fresh = !prev || prev.code !== r.code;
  const newGame = fresh || prev.games !== r.games;
  room = r;
  view = viewFromRoom(r);
  netDown = false; waitingNet = false;
  saveSession({ code: r.code, token: r.token });
  turnEnd = performance.now() + r.remain;
  if (newGame) { seenMove = r.lastMove ? r.lastMove.seq : 0; ghost = -1; lastCell = -1; say(''); }
  if (r.state === 'waiting') { phase = 'title'; showWaiting(); drawBoard(r.n); render(); return; }
  phase = r.state === 'playing' ? 'play' : 'over';
  if (newGame) drawBoard(r.n);
  if (newGame && r.state === 'playing') { sfx.found(); say(`내 돌은 ${SIDE_NAME[r.you]}색 (${ROLE[r.you]})\n${r.turn === r.you ? '내가 먼저 놓아요' : '상대가 먼저 놓아요'}${r.swap ? ' · 스왑 규칙 켬' : ''}`); }
  if (!($('overlay').dataset.screen === 'confirm') && r.state !== 'over') hideOverlay();
  const lm = r.lastMove;
  if (lm && lm.seq > seenMove && !newGame) {
    seenMove = lm.seq;
    lastCell = lm.type === 'place' ? lm.cell : lm.to;
    render();
    announce(Object.assign({}, lm, { over: r.state === 'over' }));
  } else if (lm && newGame) lastCell = lm.type === 'place' ? lm.cell : lm.to;
  render();
  if (r.state === 'over') afterOver();
}
function afterOver() {
  const r = room;
  const key = `${r.code}:${r.games}:${r.reason}:${r.winner}`;
  if (recorded !== key) {
    recorded = key;
    const rec = loadJson(ONLINE_KEY);
    if (r.winner === r.you) { rec.w = (rec.w || 0) + 1; sfx.win(); } else { rec.l = (rec.l || 0) + 1; sfx.lose(); }
    store.set(ONLINE_KEY, JSON.stringify(rec));
    setTimeout(() => { if (room && room.state === 'over') showResult(); }, T.over);
  } else if (overlayOpen()) showResult();
}

function showResult() {
  const r = room;
  const won = r.winner === r.you;
  const why = {
    connect: won ? '내가 먼저 두 변을 이었어요' : '상대가 두 변을 이었어요',
    resign: won ? '상대가 기권했어요' : '기권했어요',
    timeout: won ? '상대가 시간을 넘겼어요' : '시간을 넘겼어요',
    left: won ? '상대가 나갔어요' : '연결이 끊겨 패배했어요',
  }[r.reason] || '';
  const rec = loadJson(ONLINE_KEY);
  const opp = r.players.find((p) => p.color !== r.you);
  const iVoted = r.rematch.includes(r.you), theyVoted = opp && r.rematch.includes(opp.color);
  let again;
  if (!opp) again = '<p>상대가 방을 나갔어요</p>';
  else if (iVoted) again = '<p>상대를 기다리는 중…</p>';
  else again = `${theyVoted ? '<p>상대가 한 판 더 하고 싶어해요!</p>' : ''}<button data-act="rematch">한 판 더</button>`;
  showOverlay(`
    <h2>${won ? '🎉 승리!' : '😵 패배'}</h2>
    ${why ? `<p>${esc(why)}</p>` : ''}
    <span class="tag">온라인 ${rec.w || 0}승 ${rec.l || 0}패</span>
    <div class="col">${again}
      <div class="row"><button class="sub" data-act="view">판 보기</button><button class="sub" data-act="leave">나가기</button></div>
    </div>`);
}

function showOnline(error = '') {
  leaveOnline();
  clearTimeout(cpuTimer); clearTimeout(overTimer);
  mode = 'online'; phase = 'title'; room = null; view = null; st = L.newGame(9, true); waitingNet = false; ghost = -1; thinking = false; lastCell = -1; drawBoard(9);
  say(''); render();
  showOverlay(`
    <h2>🌐 온라인 대전</h2>
    <input id="nameInput" maxlength="10" placeholder="내 이름 (최대 10자)" value="${esc(myName())}" autocomplete="off">
    <div class="col">
      <button data-act="quick">⚡ 빠른 대전<small>9줄 · 스왑 켬</small></button>
      <button class="sub" data-act="create">방 만들기</button>
      ${settingsHtml('방 만들기는 위에서 고른 판 크기·스왑으로 열려요')}
      <div class="row join"><input id="codeInput" maxlength="4" placeholder="방 코드" autocomplete="off" autocapitalize="characters"><button class="sub" data-act="join">들어가기</button></div>
    </div>
    <span class="error">${esc(error)}</span>
    <button class="back" data-act="home">← 처음으로</button>
    <p style="font-size:12.5px">한 번 놓을 때마다 60초 · 먼저 하는 쪽은 한 판마다 바뀌어요</p>`);
}
function showQueued() {
  showOverlay(`
    <h2>상대를 찾는 중…</h2>
    <div class="dots"><span></span><span></span><span></span></div>
    <p>누군가 빠른 대전을 누르면 바로 시작해요</p>
    <button class="sub" data-act="cancel">취소</button>`);
}
const inviteUrl = () => `${location.origin}${location.pathname}?room=${room.code}`;
function showWaiting() {
  showOverlay(`
    <h2>친구를 기다리는 중…</h2>
    <p>방 코드</p>
    <div class="code">${esc(room.code)}</div>
    <p>${room.n}줄 · 스왑 ${room.swap ? '켬' : '끔'}<br>친구가 <b>온라인 대전 → 들어가기</b>에<br>이 코드를 넣으면 시작해요</p>
    <button data-act="copy">🔗 초대 링크 복사</button>
    <button class="sub" data-act="cancel">취소</button>`);
}
function saveName() {
  const input = $('nameInput');
  if (!input) return;
  const name = input.value.trim().slice(0, 10);
  store.set('hexName', name);
  net.send('hello', { name });
}
function confirmResign() {
  showOverlay(`<h2>기권할까요?</h2><p>이번 판은 패배로 기록돼요</p>
    <div class="row"><button data-act="close">계속하기</button><button class="sub" data-act="resign">🏳 기권</button></div>`);
  $('overlay').dataset.screen = 'confirm';
}

let lastCpu = 'easy';
$('overlay').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  btn.blur();
  $('overlay').dataset.screen = '';
  const act = btn.dataset.act;
  if (act === 'size' || act === 'swapopt') {
    if (act === 'size') { setSize = Number(btn.dataset.n); store.set('hexSize', String(setSize)); }
    else { setSwap = btn.dataset.v === '1'; store.set('hexSwap', setSwap ? '1' : '0'); }
    btn.parentElement.parentElement.querySelectorAll('.seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.act === 'size' && Number(b.dataset.n) === setSize) || (b.dataset.act === 'swapopt' && (b.dataset.v === '1') === setSwap)));
    });
    return;
  }
  if (act === 'cpu') { lastCpu = btn.dataset.lv; startCpu(lastCpu, 0); }
  else if (act === 'again') startCpu(lastCpu, 1 - cpuYou);
  else if (act === 'home') showTitle();
  else if (act === 'online') showOnline();
  else if (act === 'quick') { saveName(); net.send('quick'); }
  else if (act === 'create') { saveName(); net.send('create', { size: setSize, swap: setSwap }); }
  else if (act === 'join') {
    const code = ($('codeInput').value || '').trim().toUpperCase();
    if (code.length !== 4) { $('overlay').querySelector('.error').textContent = '방 코드 4자리를 넣어 주세요.'; return; }
    saveName();
    net.send('join', { code });
  } else if (act === 'cancel') { net.send('cancel'); showOnline(); }
  else if (act === 'copy') {
    const url = inviteUrl();
    const done = () => { btn.textContent = '✅ 복사했어요'; setTimeout(() => { btn.textContent = '🔗 초대 링크 복사'; }, 1500); };
    if (navigator.share && matchMedia('(pointer: coarse)').matches) navigator.share({ title: '헥스 한 판 해요!', url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('링크를 복사하세요', url));
    else prompt('링크를 복사하세요', url);
  } else if (act === 'rematch') { net.send('rematch'); }
  else if (act === 'view') hideOverlay();
  else if (act === 'leave') showOnline();
  else if (act === 'resign') { net.send('resign'); hideOverlay(); }
  else if (act === 'close') hideOverlay();
});
$('overlay').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'codeInput') $('overlay').querySelector('[data-act="join"]').click();
  if (e.target.id === 'nameInput') $('overlay').querySelector('[data-act="quick"]').click();
  e.stopPropagation();
});
$('resignBtn').onclick = (e) => { e.currentTarget.blur(); if (online() && room && room.state === 'playing') confirmResign(); };
setInterval(() => { if (online() && room && room.state === 'playing' && !netDown) renderHud(); }, 500);

// ---------- 시작 ----------
const invite = new URLSearchParams(location.search).get('room');
if (invite) { try { window.history.replaceState(null, '', location.pathname); } catch (_) {} }
function joinInvite(code) { showOnline(); net.send('join', { code: code.toUpperCase() }); }
if (loadSession()) {
  mode = 'online';
  view = null; drawBoard(9); render();
  showOverlay('<h2>대국으로 돌아가는 중…</h2>');
  net.connect();
  const until = setInterval(() => {
    if (room || !loadSession()) { clearInterval(until); if (!room) invite ? joinInvite(invite) : showOnline(); }
  }, 100);
} else if (invite) joinInvite(invite);
else showTitle();

/* @test-hooks:start */
window.__hx = { get st() { return st; }, get mode() { return mode; }, get phase() { return phase; }, get room() { return room; }, get ghost() { return ghost; }, get thinking() { return thinking; }, T, dispatch, startCpu, render, model };
/* @test-hooks:end */
})();
