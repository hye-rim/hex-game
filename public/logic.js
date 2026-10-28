'use strict';
// 헥스: 규칙과 컴퓨터. 화면 없이 Node 에서 시험한다 (브라우저에서는 전역 LOGIC_HEX).
// 칸 번호 = 줄 * n + 칸. 칸 값 0 비어 있음, 1 첫 번째 사람의 돌(위·아래 변 잇기), 2 두 번째 사람의 돌(왼쪽·오른쪽 변 잇기).
// 육각형 이웃: 같은 줄의 양옆, 위줄의 (칸, 칸+1), 아랫줄의 (칸-1, 칸)
const LOGIC_HEX = (() => {
  const SIZES = [7, 9, 11];
  const HARD_SLIP = 0.25;            // 어려움도 네 번에 한 번쯤은 쉬움처럼 둔다 (사람이 이길 수 있게)
  const INF = 1e9;

  const nbCache = {};
  function neighbors(n) {
    if (nbCache[n]) return nbCache[n];
    const out = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const list = [];
        for (const [dr, dc] of [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, -1], [1, 0]]) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < n && cc >= 0 && cc < n) list.push(rr * n + cc);
        }
        out.push(list);
      }
    }
    return (nbCache[n] = out);
  }

  function newGame(n = 9, swap = true) {
    if (!SIZES.includes(n)) n = 9;
    return { n, swap: !!swap, board: new Array(n * n).fill(0), turn: 0, plies: 0, stones: 0, over: false, winner: -1, reason: '', path: [], last: null };
  }

  const canSwap = (g) => g.swap && !g.over && g.plies === 1 && g.stones === 1;
  const emptyCells = (g) => { const out = []; g.board.forEach((v, i) => { if (!v) out.push(i); }); return out; };
  const isEdgeStart = (n, side, i) => (side === 0 ? i < n : i % n === 0);
  const isEdgeEnd = (n, side, i) => (side === 0 ? i >= n * (n - 1) : i % n === n - 1);

  // side(0/1)의 돌이 두 변을 이었으면 그 길(칸 번호 목록), 아니면 null
  function connected(board, n, side) {
    const me = side + 1, nb = neighbors(n);
    const prev = new Int16Array(n * n).fill(-2);
    const queue = [];
    for (let k = 0; k < n; k++) {
      const i = side === 0 ? k : k * n;
      if (board[i] === me) { prev[i] = -1; queue.push(i); }
    }
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      if (isEdgeEnd(n, side, i)) {
        const path = [];
        for (let j = i; j >= 0; j = prev[j]) path.push(j);
        return path.reverse();
      }
      for (const j of nb[i]) if (board[j] === me && prev[j] === -2) { prev[j] = i; queue.push(j); }
    }
    return null;
  }

  // side 가 두 변을 잇는 데 더 놓아야 하는 돌 수의 최소값 (상대 돌은 못 지나감). 막혔으면 INF
  function distance(board, n, side) {
    const me = side + 1, opp = 2 - side, nb = neighbors(n);
    const d = new Int16Array(n * n).fill(30000);
    const buckets = [];
    const push = (i, cost) => { d[i] = cost; (buckets[cost] || (buckets[cost] = [])).push(i); };
    for (let k = 0; k < n; k++) {
      const i = side === 0 ? k : k * n;
      if (board[i] !== opp) push(i, board[i] === me ? 0 : 1);
    }
    for (let cost = 0; cost < buckets.length; cost++) {
      const bucket = buckets[cost];
      if (!bucket) continue;
      for (let h = 0; h < bucket.length; h++) {
        const i = bucket[h];
        if (d[i] !== cost) continue;
        if (isEdgeEnd(n, side, i)) return cost;
        for (const j of nb[i]) {
          if (board[j] === opp) continue;
          const nc = cost + (board[j] === me ? 0 : 1);
          if (nc < d[j]) push(j, nc);
        }
      }
    }
    return INF;
  }

  // 한 동작을 둔다. { type:'place', cell } 또는 { type:'swap' }. 규칙에 맞지 않으면 null
  function apply(g, a) {
    if (!a || g.over) return null;
    const who = g.turn;
    if (a.type === 'swap') {
      if (!canSwap(g)) return null;
      const from = g.board.findIndex((v) => v === 1);
      const r = (from / g.n) | 0, c = from % g.n;
      const to = c * g.n + r;                          // 첫 돌을 대각선으로 뒤집어(줄↔칸) 두 번째 사람의 돌로 바꾼다
      g.board[from] = 0;
      g.board[to] = 2;
      g.plies++;
      g.turn = 0;
      g.last = { who, type: 'swap', from, to };
      return { who, type: 'swap', from, to, over: false };
    }
    if (a.type !== 'place' || !Number.isInteger(a.cell) || a.cell < 0 || a.cell >= g.n * g.n || g.board[a.cell]) return null;
    g.board[a.cell] = who + 1;
    g.stones++;
    g.plies++;
    g.last = { who, type: 'place', cell: a.cell };
    const path = connected(g.board, g.n, who);
    if (path) { g.over = true; g.winner = who; g.reason = 'connect'; g.path = path; }
    else g.turn = 1 - who;
    return { who, type: 'place', cell: a.cell, over: g.over, winner: g.winner };
  }

  // ---------- 컴퓨터 ----------
  const centrality = (n, i) => {
    const m = (n - 1) / 2;
    return n - (Math.abs(((i / n) | 0) - m) + Math.abs((i % n) - m));
  };
  // 첫 돌이 가운데쪽이면 바꿔 가진다 (가장자리·모서리 돌은 약하니 그냥 둔다)
  function wantSwap(g, level, rng) {
    const i = g.board.findIndex((v) => v === 1), q = Math.floor(g.n / 4);
    const r = (i / g.n) | 0, c = i % g.n;
    const central = r >= q && r <= g.n - 1 - q && c >= q && c <= g.n - 1 - q;
    return central && (level === 'hard' || rng() < 0.5);
  }
  function easyMove(g, rng) {
    const nb = neighbors(g.n), cells = emptyCells(g), weights = [];
    let sum = 0;
    for (const i of cells) {
      let w = 1 + centrality(g.n, i) * 0.25;
      if (nb[i].some((j) => g.board[j])) w += 3;
      weights.push(w); sum += w;
    }
    let x = rng() * sum;
    for (let k = 0; k < cells.length; k++) { x -= weights[k]; if (x <= 0) return cells[k]; }
    return cells[cells.length - 1];
  }
  // 내가 here 에 두었다고 치고, 내 쪽이 얼마나 유리한지 (상대가 이으려면 필요한 돌 - 내가 이으려면 필요한 돌)
  function score(board, n, side, cell) {
    board[cell] = side + 1;
    const dm = distance(board, n, side), dopp = distance(board, n, 1 - side);
    board[cell] = 0;
    return (dopp - dm) * 10 + centrality(n, cell) * 0.1;
  }
  function hardMove(g, side) {
    const { n } = g, board = g.board.slice();
    const cells = emptyCells(g);
    // 두면 바로 이기는 자리 · 상대가 두면 바로 이기는 자리
    for (const i of cells) { board[i] = side + 1; const w = connected(board, n, side); board[i] = 0; if (w) return i; }
    const must = [];
    for (const i of cells) { board[i] = 2 - side; const w = connected(board, n, 1 - side); board[i] = 0; if (w) must.push(i); }
    if (must.length) return must[0];
    const ranked = cells.map((i) => ({ i, s: score(board, n, side, i) })).sort((a, b) => b.s - a.s).slice(0, 12);
    let best = ranked[0].i, bestV = -INF;
    for (const cand of ranked) {
      board[cand.i] = side + 1;
      const empty = cells.filter((i) => i !== cand.i);
      const replies = empty.map((i) => ({ i, s: score(board, n, 1 - side, i) })).sort((a, b) => b.s - a.s).slice(0, 8);
      let worst = INF;
      for (const rp of replies) {
        board[rp.i] = 2 - side;
        const v = (distance(board, n, 1 - side) - distance(board, n, side)) * 10 + centrality(n, cand.i) * 0.1;
        board[rp.i] = 0;
        if (v < worst) worst = v;
      }
      board[cand.i] = 0;
      if (worst > bestV) { bestV = worst; best = cand.i; }
    }
    return best;
  }
  function aiPick(g, level = 'easy', rng = Math.random) {
    if (g.over) return null;
    if (canSwap(g) && wantSwap(g, level, rng)) return { type: 'swap' };
    if (level === 'hard' && rng() >= HARD_SLIP) return { type: 'place', cell: hardMove(g, g.turn) };
    if (level !== 'hard') {
      // 쉬움은 한 수 만에 이길 수 있으면 대체로 이긴다 (놓치기도 한다)
      if (rng() < 0.7) {
        const board = g.board.slice();
        for (const i of emptyCells(g)) { board[i] = g.turn + 1; const w = connected(board, g.n, g.turn); board[i] = 0; if (w) return { type: 'place', cell: i }; }
      }
    }
    return { type: 'place', cell: easyMove(g, rng) };
  }

  return { SIZES, HARD_SLIP, neighbors, newGame, canSwap, emptyCells, connected, distance, apply, aiPick };
})();
if (typeof module !== 'undefined') module.exports = LOGIC_HEX;
