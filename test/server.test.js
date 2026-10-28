'use strict';

// 서버 시험: 보안·안정성 회귀 + 헥스 온라인 대국 흐름
// 실행: npm test  (Node 18 이상, 별도 설치 없이 node:test)
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');
const L = require('../public/logic.js');

// 운영체제가 지금 비어 있는 포트를 골라 준다 (고정 포트·범위 난수는 다른 서버와 겹쳐 가끔 실패한다)
const freePort = () => Number(require('child_process').execFileSync(process.execPath, ['-e', "const s = require('net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })"]));
const PORT = freePort();
const get = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), TURN_MS: '2500' }, stdio: 'ignore' });
child.unref();
process.on('exit', () => child.kill());
const ready = (async () => {
  for (let i = 0; i < 80; i++) { try { await get('/'); return; } catch { await sleep(100); } }
  throw new Error('server did not start');
})();

const open = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  const c = { ws, msgs: [], room: null, queued: false, errors: [], closed: null };
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    c.msgs.push(m);
    if (m.t === 'room') c.room = m;
    if (m.t === 'queued') c.queued = true;
    if (m.t === 'error') c.errors.push(m.msg);
  });
  ws.on('close', (code) => { c.closed = code; });
  ws.on('error', () => {});
  ws.on('open', () => resolve(c));
  setTimeout(() => reject(new Error('websocket connect failed')), 3000);
});
const send = (c, t, p = {}) => c.ws.send(JSON.stringify({ t, ...p }));
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); } return false; };

// 두 손님을 빠른 대전으로 맺어 준다
async function pair() {
  const a = await open(), b = await open();
  send(a, 'hello', { name: '가' }); send(b, 'hello', { name: '나' });
  send(a, 'quick'); await until(() => a.queued);
  send(b, 'quick');
  assert.ok(await until(() => a.room && b.room && a.room.state === 'playing' && b.room.state === 'playing'), 'both players enter a playing room');
  return [a, b];
}
const mover = (a, b) => (a.room.turn === a.room.you ? a : b);
const closeAll = (...cs) => cs.forEach((c) => c.ws.close());
const act = (c, action) => send(c, 'act', { action });
const stamp = (room) => JSON.stringify([room.board, room.turn, room.plies]);
const emptyOf = (room) => room.board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);

test('malformed URLs get 400 and the server stays up', async () => {
  await ready;
  assert.strictEqual(await get('/%'), 400);
  assert.strictEqual(await get('/%00'), 400);
  assert.strictEqual(await get('/'), 200);
  assert.strictEqual(await get('/logic.js'), 200);
});

test('dotfiles and paths outside the public dir are not served', async () => {
  await ready;
  assert.strictEqual(await get('/.git/config'), 403);
  assert.ok([403, 404].includes(await get('/../server.js')));
});

test('oversized websocket message closes the connection (1009)', async () => {
  await ready;
  const c = await open();
  c.ws.send('x'.repeat(2 * 1024 * 1024));
  await sleep(500);
  assert.strictEqual(c.closed, 1009);
  assert.strictEqual(await get('/'), 200);
});

test('quick match starts on an empty 9x9 board with the swap rule, first mover is seat 0', async () => {
  await ready;
  const [a, b] = await pair();
  assert.notStrictEqual(a.room.you, b.room.you);
  assert.strictEqual(a.room.turn, 0);
  assert.strictEqual(a.room.n, 9);
  assert.strictEqual(a.room.swap, true);
  assert.deepStrictEqual(a.room.board, L.newGame(9).board);
  assert.deepStrictEqual(a.room.board, b.room.board);
  const first = mover(a, b);
  assert.strictEqual(first.room.you, 0);
  assert.strictEqual(first.room.canSwap, false, 'nothing to swap before the first stone');
  closeAll(a, b);
});

test('out-of-turn and garbage actions are ignored', async () => {
  await ready;
  const [a, b] = await pair();
  const first = mover(a, b), second = first === a ? b : a;
  const before = stamp(a.room);
  act(second, { type: 'place', cell: 40 });                         // 내 차례가 아님
  act(second, { type: 'swap' });
  const junk = [{}, { type: 'place' }, { type: 'place', cell: 'a' }, { type: 'place', cell: 1.5 }, { type: 'place', cell: -1 }, { type: 'place', cell: 81 },
    { type: 'place', cell: 1e9 }, { type: ['place'] }, { type: null }, { type: 'swap' }, { type: 'move', from: 1, to: 2 }, [], 'place', 5, null];
  for (const action of junk) act(first, action);
  send(first, 'act');
  send(first, 'act', { action: 'x' });
  await sleep(300);
  assert.strictEqual(stamp(a.room), before, 'nothing happened');
  assert.strictEqual(a.room.turn, 0);
  assert.strictEqual(await get('/'), 200, 'the server survived');
  closeAll(a, b);
});

test('a stone shows on both boards, passes the turn and reports the last move', async () => {
  await ready;
  const [a, b] = await pair();
  const first = mover(a, b), second = first === a ? b : a;
  act(first, { type: 'place', cell: 40 });
  assert.ok(await until(() => a.room.turn === 1 && b.room.turn === 1));
  assert.strictEqual(a.room.board[40], 1);
  assert.deepStrictEqual(a.room.board, b.room.board);
  assert.deepStrictEqual({ who: a.room.lastMove.who, type: a.room.lastMove.type, cell: a.room.lastMove.cell, seq: a.room.lastMove.seq }, { who: 0, type: 'place', cell: 40, seq: 1 });
  assert.strictEqual(second.room.canSwap, true, 'the second player may swap');
  assert.strictEqual(first.room.canSwap, false);
  act(first, { type: 'place', cell: 41 });                          // 이제 상대 차례
  await sleep(200);
  assert.strictEqual(a.room.board[41], 0);
  act(second, { type: 'place', cell: 40 });                         // 이미 돌이 있는 자리
  await sleep(200);
  assert.strictEqual(a.room.turn, 1);
  assert.ok(second.msgs.some((m) => m.t === 'rejected'), 'the sender is told');
  closeAll(a, b);
});

test('swap flips the first stone to the other player and hands the move back', async () => {
  await ready;
  const [a, b] = await pair();
  const first = mover(a, b), second = first === a ? b : a;
  act(first, { type: 'place', cell: 1 * 9 + 4 });
  assert.ok(await until(() => second.room.canSwap === true));
  act(second, { type: 'swap' });
  assert.ok(await until(() => a.room.turn === 0 && a.room.plies === 2 && b.room.plies === 2));
  assert.strictEqual(a.room.board[1 * 9 + 4], 0);
  assert.strictEqual(a.room.board[4 * 9 + 1], 2);
  assert.strictEqual(a.room.lastMove.type, 'swap');
  assert.strictEqual(first.room.canSwap, false);
  act(second, { type: 'swap' });                                     // 두 번은 안 된다
  await sleep(200);
  assert.strictEqual(a.room.plies, 2);
  closeAll(a, b);
});

test('two players fill a game with random stones and it ends with a winner', async () => {
  await ready;
  const [a, b] = await pair();
  for (let i = 0; i < 81 && a.room.state === 'playing'; i++) {
    const m = mover(a, b);
    const before = stamp(m.room);
    const cells = emptyOf(m.room);
    act(m, { type: 'place', cell: cells[Math.floor(Math.random() * cells.length)] });
    await until(() => a.room.state === 'over' || (stamp(a.room) !== before && stamp(b.room) === stamp(a.room)), 3000);
    assert.deepStrictEqual(a.room.board, b.room.board);
  }
  assert.strictEqual(a.room.state, 'over');
  assert.strictEqual(a.room.reason, 'connect');
  assert.ok(a.room.winner === 0 || a.room.winner === 1);
  assert.ok(a.room.path.length >= 9, 'the winning chain is reported');
  assert.strictEqual(L.connected(a.room.board, 9, a.room.winner).length, a.room.path.length);
  closeAll(a, b);
});

test('a private room keeps the size and swap setting the host chose', async () => {
  await ready;
  const a = await open(), b = await open();
  send(a, 'create', { size: 7, swap: false });
  assert.ok(await until(() => a.room && a.room.code));
  assert.strictEqual(a.room.n, 7);
  assert.strictEqual(a.room.swap, false);
  send(b, 'join', { code: a.room.code });
  assert.ok(await until(() => a.room.state === 'playing' && b.room && b.room.state === 'playing'));
  assert.strictEqual(b.room.n, 7);
  assert.strictEqual(b.room.board.length, 49);
  const first = a.room.turn === a.room.you ? a : b, second = first === a ? b : a;
  act(first, { type: 'place', cell: 24 });
  assert.ok(await until(() => second.room.turn === second.room.you));
  assert.strictEqual(second.room.canSwap, false, 'swap rule is off in this room');
  const c = await open(), d = await open();
  send(c, 'create', { size: 5, swap: true });                        // 모르는 크기는 9 로
  assert.ok(await until(() => c.room && c.room.code));
  assert.strictEqual(c.room.n, 9);
  closeAll(a, b, c, d);
});

test('resigning ends the game and rematch swaps sides', async () => {
  await ready;
  const [a, b] = await pair();
  const sideA = a.room.you;
  send(a, 'resign');
  assert.ok(await until(() => b.room.state === 'over'));
  assert.strictEqual(b.room.reason, 'resign');
  assert.strictEqual(b.room.winner, b.room.you);
  send(a, 'rematch'); send(b, 'rematch');
  assert.ok(await until(() => a.room.state === 'playing' && a.room.games === 2));
  assert.notStrictEqual(a.room.you, sideA, 'sides swap on a rematch');
  assert.deepStrictEqual(a.room.board, L.newGame(9).board);
  closeAll(a, b);
});

test('running out of time loses the game for the one on move', async () => {
  await ready;
  const [a, b] = await pair();
  const first = mover(a, b);
  assert.ok(await until(() => a.room.state === 'over', 5000), 'the timer fires');
  assert.strictEqual(a.room.reason, 'timeout');
  assert.strictEqual(a.room.winner, 1 - first.room.you);
  closeAll(a, b);
});

test('private rooms: create, join by code, and a third player is turned away', async () => {
  await ready;
  const a = await open(), b = await open(), c = await open();
  send(a, 'create');
  assert.ok(await until(() => a.room && a.room.code));
  assert.strictEqual(a.room.state, 'waiting');
  send(b, 'join', { code: a.room.code.toLowerCase() });
  assert.ok(await until(() => a.room.state === 'playing' && b.room && b.room.state === 'playing'));
  send(c, 'join', { code: a.room.code });
  assert.ok(await until(() => c.errors.length > 0));
  assert.match(c.errors[0], /이미 두 사람/);
  a.ws.close(); b.ws.close(); c.ws.close();
});

test('a dropped player can resume the same seat with the token', async () => {
  await ready;
  const [a, b] = await pair();
  const token = a.room.token, code = a.room.code, you = a.room.you;
  a.ws.close();
  assert.ok(await until(() => b.room.players.some((p) => !p.online)), 'the other side sees the drop');
  const a2 = await open();
  send(a2, 'resume', { code, token });
  assert.ok(await until(() => a2.room && a2.room.you === you && a2.room.state === 'playing'));
  assert.ok(await until(() => b.room.players.every((p) => p.online)));
  a2.ws.close(); b.ws.close();
});

// 같은 주소에서 코드를 일부러 많이 틀리므로 이 시험은 맨 뒤에 둔다 (뒤의 시험이 막히지 않게)
test('repeated wrong room codes get temporarily blocked', async () => {
  await ready;
  const c = await open();
  for (let i = 0; i < 10; i++) c.ws.send(JSON.stringify({ t: 'join', code: 'ZZZ' + 'ABCDEFGH'[i] }));
  await sleep(500);
  assert.ok(c.errors.some((x) => /그런 방이 없어요/.test(x)), 'first attempts are answered with room-not-found');
  assert.ok(c.errors.some((x) => /너무 많이 틀렸어요/.test(x)), 'many wrong codes get blocked');
  c.ws.close();
});

test('shutdown', () => { child.kill(); });
