'use strict';

// 헥스 규칙·컴퓨터 시험. 실행: npm test (node --test)
const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/logic.js');

// 고정 난수 (확률이 걸린 시험은 항상 같은 결과가 나오게)
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const place = (g, r, c) => L.apply(g, { type: 'place', cell: r * g.n + c });

test('neighbor counts: inside 6, edges 4, acute corner 2, obtuse corner 3', () => {
  const n = 7, nb = L.neighbors(n);
  assert.strictEqual(nb[3 * n + 3].length, 6);
  assert.strictEqual(nb[0 * n + 3].length, 4);
  assert.strictEqual(nb[3 * n + 0].length, 4);
  assert.strictEqual(nb[0].length, 2);
  assert.strictEqual(nb[n * n - 1].length, 2);
  assert.strictEqual(nb[n - 1].length, 3);
  assert.strictEqual(nb[n * (n - 1)].length, 3);
  nb.forEach((list, i) => list.forEach((j) => assert.ok(nb[j].includes(i), 'neighbors are mutual')));
});

test('new game is empty, first player moves, size falls back to 9', () => {
  const g = L.newGame(11);
  assert.strictEqual(g.board.length, 121);
  assert.ok(g.board.every((v) => v === 0));
  assert.strictEqual(g.turn, 0);
  assert.strictEqual(L.newGame(5).n, 9);
  assert.strictEqual(L.newGame(7).board.length, 49);
});

test('placing alternates the turn and rejects bad cells', () => {
  const g = L.newGame(7);
  assert.ok(place(g, 3, 3));
  assert.strictEqual(g.turn, 1);
  assert.strictEqual(L.apply(g, { type: 'place', cell: 3 * 7 + 3 }), null, 'occupied');
  for (const bad of [{ type: 'place', cell: -1 }, { type: 'place', cell: 49 }, { type: 'place', cell: 1.5 }, { type: 'place', cell: '3' }, { type: 'place' }, { type: 'x' }, {}, null, undefined, 5]) {
    assert.strictEqual(L.apply(g, bad), null);
  }
  assert.strictEqual(g.turn, 1);
  assert.ok(place(g, 0, 0));
  assert.strictEqual(g.turn, 0);
  assert.strictEqual(g.board[0], 2);
});

test('a straight column connects top and bottom for the first player', () => {
  const g = L.newGame(7);
  for (let r = 0; r < 7; r++) {
    assert.strictEqual(g.over, false);
    const ev = place(g, r, 3);
    if (r < 6) { assert.strictEqual(ev.over, false); place(g, r, 0); }   // 상대는 왼쪽 줄을 따라 두지만 일곱 칸을 못 채운다
  }
  assert.strictEqual(g.over, true);
  assert.strictEqual(g.winner, 0);
  assert.strictEqual(g.reason, 'connect');
  assert.strictEqual(g.path.length, 7);
  assert.strictEqual(L.apply(g, { type: 'place', cell: 10 }), null, 'no moves after the end');
});

test('a straight row connects left and right for the second player', () => {
  const g = L.newGame(7);
  for (let c = 0; c < 7; c++) {
    if (g.over) break;
    place(g, 0, (c + 6) % 7);   // 첫 번째 사람은 맨 윗줄만 채우니 위아래를 이을 수 없다
    if (g.over) break;
    place(g, 3, c);
  }
  assert.strictEqual(g.over, true);
  assert.strictEqual(g.winner, 1);
});

test('hex adjacency: the anti-diagonal connects, the main diagonal does not', () => {
  const anti = L.newGame(7), main = L.newGame(7);
  for (let r = 0; r < 7; r++) { anti.board[r * 7 + (6 - r)] = 1; main.board[r * 7 + r] = 1; }
  assert.ok(L.connected(anti.board, 7, 0), 'cells (r, 6-r) touch each other');
  assert.strictEqual(L.connected(main.board, 7, 0), null, 'cells (r, r) do not touch');
  assert.strictEqual(L.distance(main.board, 7, 0) > 0, true);
  assert.strictEqual(L.distance(anti.board, 7, 0), 0);
});

test('swap: only right after the first stone, flips it across the diagonal and gives the move back', () => {
  const g = L.newGame(7, true);
  assert.strictEqual(L.canSwap(g), false, 'nothing to swap yet');
  assert.strictEqual(L.apply(g, { type: 'swap' }), null);
  place(g, 1, 4);
  assert.strictEqual(L.canSwap(g), true);
  const ev = L.apply(g, { type: 'swap' });
  assert.strictEqual(ev.type, 'swap');
  assert.strictEqual(g.board[1 * 7 + 4], 0);
  assert.strictEqual(g.board[4 * 7 + 1], 2, 'the stone moved to (4,1) and now belongs to the second player');
  assert.strictEqual(g.turn, 0);
  assert.strictEqual(L.canSwap(g), false, 'only once');
  place(g, 3, 3);
  assert.strictEqual(L.apply(g, { type: 'swap' }), null);
});

test('swap is refused when the rule is off or after a second stone', () => {
  const off = L.newGame(7, false);
  place(off, 3, 3);
  assert.strictEqual(L.canSwap(off), false);
  assert.strictEqual(L.apply(off, { type: 'swap' }), null);
  const on = L.newGame(7, true);
  place(on, 3, 3); place(on, 2, 2);
  assert.strictEqual(L.apply(on, { type: 'swap' }), null);
});

test('no draws: every full board has exactly one connected side', () => {
  const rng = seeded(2024);
  for (const n of L.SIZES) {
    for (let k = 0; k < 150; k++) {
      const cells = Array.from({ length: n * n }, (_, i) => i);
      for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
      const board = new Array(n * n).fill(0);
      cells.forEach((cell, idx) => { board[cell] = (idx % 2) + 1; });
      const a = !!L.connected(board, n, 0), b = !!L.connected(board, n, 1);
      assert.strictEqual(a !== b, true, `size ${n} board ${k}: exactly one side wins`);
    }
  }
});

test('random games always end with a winner before the board overflows', () => {
  const rng = seeded(7);
  for (const n of L.SIZES) {
    for (let k = 0; k < 30; k++) {
      const g = L.newGame(n, false);
      while (!g.over) {
        const cells = L.emptyCells(g);
        assert.ok(cells.length > 0, 'a game cannot run out of cells without a winner');
        L.apply(g, { type: 'place', cell: cells[Math.floor(rng() * cells.length)] });
      }
      assert.ok(g.winner === 0 || g.winner === 1);
      assert.ok(g.path.length >= n);
      assert.ok(g.stones <= n * n);
    }
  }
});

test('distance counts the stones still needed and gets blocked by a wall', () => {
  for (const n of L.SIZES) {
    const g = L.newGame(n);
    assert.strictEqual(L.distance(g.board, n, 0), n);
    assert.strictEqual(L.distance(g.board, n, 1), n);
  }
  const g = L.newGame(7);
  for (let r = 0; r < 3; r++) g.board[r * 7 + 3] = 1;
  assert.strictEqual(L.distance(g.board, 7, 0), 4);
  assert.strictEqual(L.distance(g.board, 7, 1), 7);
  for (let c = 0; c < 7; c++) g.board[3 * 7 + c] = 2;        // 가운데 줄을 상대가 모두 막으면 길이 없다
  assert.ok(L.distance(g.board, 7, 0) >= 1e9);
  assert.strictEqual(L.distance(g.board, 7, 1), 0);
});

test('computer takes a win in one move', () => {
  const rigged = () => 0.99;                                  // 실수 없이
  const g = L.newGame(7, false);
  for (let r = 0; r < 6; r++) g.board[r * 7 + 3] = 1;         // 위에서 여섯 칸을 이었고 아랫줄 (6,2) 나 (6,3) 이면 끝
  g.board[6 * 7 + 0] = 2;
  g.stones = 7; g.plies = 7; g.turn = 0;
  const a = L.aiPick(g, 'hard', rigged);
  assert.ok(a.type === 'place' && [6 * 7 + 2, 6 * 7 + 3].includes(a.cell));
  assert.ok(L.apply(g, a).over);
  assert.strictEqual(g.winner, 0);
});

test('computer blocks a one-move win of the opponent', () => {
  const rigged = () => 0.99;
  const g = L.newGame(7, false);
  // 첫 번째 사람이 (0,3)~(5,3) 까지 이었고 아랫줄 길목 (6,2) 는 이미 막혀, (6,3) 하나만 남았다. 두 번째 사람(컴퓨터) 차례
  for (let r = 0; r < 6; r++) g.board[r * 7 + 3] = 1;
  g.board[6 * 7 + 2] = 2;                                      // (6,3) 하나만 남은 길목
  g.stones = 7; g.plies = 7; g.turn = 1;
  const a = L.aiPick(g, 'hard', rigged);
  assert.deepStrictEqual(a, { type: 'place', cell: 6 * 7 + 3 });
});

test('computer picks only legal actions on random positions', () => {
  const rng = seeded(99);
  for (const level of ['easy', 'hard']) {
    for (let k = 0; k < 12; k++) {
      const g = L.newGame(7, k % 2 === 0);
      const plies = Math.floor(rng() * 20);
      for (let i = 0; i < plies && !g.over; i++) { const cells = L.emptyCells(g); L.apply(g, { type: 'place', cell: cells[Math.floor(rng() * cells.length)] }); }
      if (g.over) continue;
      const a = L.aiPick(g, level, rng);
      assert.ok(L.apply(g, a), `${level} gave a legal action`);
    }
  }
});

test('computer swaps a centre opening and leaves a corner opening', () => {
  const centre = L.newGame(9, true); place(centre, 4, 4);
  assert.deepStrictEqual(L.aiPick(centre, 'hard', () => 0.99), { type: 'swap' });
  const corner = L.newGame(9, true); place(corner, 0, 8);
  assert.strictEqual(L.aiPick(corner, 'hard', () => 0.99).type, 'place');
  const noSwap = L.newGame(9, false); place(noSwap, 4, 4);
  assert.strictEqual(L.aiPick(noSwap, 'hard', () => 0.99).type, 'place');
});

test('hard computer beats easy in most seeded games (both seats)', () => {
  const rng = seeded(31337);
  let hardWins = 0, games = 10;
  for (let k = 0; k < games; k++) {
    const g = L.newGame(7, true);
    const hardSide = k % 2;                                   // 0 이면 어려움이 먼저
    let guard = 0;
    while (!g.over && guard++ < 200) {
      const a = L.aiPick(g, g.turn === hardSide ? 'hard' : 'easy', rng);
      assert.ok(L.apply(g, a));
    }
    assert.ok(g.over);
    if (g.winner === hardSide) hardWins++;
  }
  assert.ok(hardWins >= 8, `hard won ${hardWins}/${games}`);
});
