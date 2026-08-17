// Degree-constrained bipartite subgraph ("b-matching") with EXACT identifiability classification.
//
// The 2015-16 / 2016-17 box scores flag more than five players per team-game. If the true starters
// are always a subset of the flagged candidates, then recovering them is a feasibility problem:
//
//     x[p,g] in {0,1}   only where p is flagged as a candidate in team-game g
//     sum_p x[p,g] = 5              every team-game starts exactly five players
//     sum_g x[p,g] = officialStarts[p]   season starts published by leaguedashplayerstats
//
// A single feasible solution is worthless on its own — there may be many, and picking one would be
// fabrication. What matters is which assignments are the SAME in every feasible solution.
//
// Classification is exact and needs no per-edge re-solve. Given one feasible solution, build the
// alternating digraph: p->g for unselected candidate edges, g->p for selected ones. Any directed
// cycle in it reroutes starters while preserving every degree constraint, so it maps one feasible
// solution to another. An edge can therefore change value iff its endpoints lie in the same
// strongly connected component. Edges whose endpoints are in different components have the same
// value in EVERY feasible solution and are the only ones we may write down.
//
//   selected   + different SCC -> FORCED_TRUE
//   unselected + different SCC -> FORCED_FALSE
//   either     + same SCC      -> AMBIGUOUS  (recorded as started = null)
//
// No tie-breaking by minutes, points, or any other heuristic is performed anywhere in this file.

/** Dinic max-flow on a node-indexed graph. */
export class MaxFlow {
  constructor(n) {
    this.n = n;
    this.to = []; this.cap = []; this.next = [];
    this.head = new Int32Array(n).fill(-1);
  }
  addEdge(u, v, c) {
    const id = this.to.length;
    this.to.push(v); this.cap.push(c); this.next.push(this.head[u]); this.head[u] = id;
    this.to.push(u); this.cap.push(0); this.next.push(this.head[v]); this.head[v] = id + 1;
    return id;
  }
  run(s, t) {
    let flow = 0;
    const level = new Int32Array(this.n);
    const iter = new Int32Array(this.n);
    const queue = new Int32Array(this.n);
    for (;;) {
      level.fill(-1);
      let qh = 0, qt = 0;
      queue[qt++] = s; level[s] = 0;
      while (qh < qt) {
        const u = queue[qh++];
        for (let e = this.head[u]; e !== -1; e = this.next[e]) {
          if (this.cap[e] > 0 && level[this.to[e]] < 0) { level[this.to[e]] = level[u] + 1; queue[qt++] = this.to[e]; }
        }
      }
      if (level[t] < 0) return flow;
      for (let i = 0; i < this.n; i++) iter[i] = this.head[i];
      for (;;) {
        const f = this.#dfs(s, t, Infinity, level, iter);
        if (f <= 0) break;
        flow += f;
      }
    }
  }
  // The level graph is S -> player -> team-game -> T, so recursion depth is bounded at 4.
  #dfs(u, t, limit, level, iter) {
    if (u === t) return limit;
    for (; iter[u] !== -1; iter[u] = this.next[iter[u]]) {
      const e = iter[u], v = this.to[e];
      if (this.cap[e] <= 0 || level[v] !== level[u] + 1) continue;
      const d = this.#dfs(v, t, Math.min(limit, this.cap[e]), level, iter);
      if (d > 0) { this.cap[e] -= d; this.cap[e ^ 1] += d; return d; }
    }
    return 0;
  }
}

/** Iterative Tarjan SCC. Returns an Int32Array of component ids. */
export function scc(n, adj) {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const stack = [];
  let idx = 0, nc = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const call = [[root, 0]];
    while (call.length) {
      const fr = call[call.length - 1];
      const u = fr[0];
      if (fr[1] === 0) { index[u] = low[u] = idx++; stack.push(u); onStack[u] = 1; }
      const list = adj[u];
      if (fr[1] < list.length) {
        const v = list[fr[1]++];
        if (index[v] === -1) call.push([v, 0]);
        else if (onStack[v]) low[u] = Math.min(low[u], index[v]);
      } else {
        if (low[u] === index[u]) {
          for (;;) { const w = stack.pop(); onStack[w] = 0; comp[w] = nc; if (w === u) break; }
          nc++;
        }
        call.pop();
        if (call.length) { const p = call[call.length - 1][0]; low[p] = Math.min(low[p], low[u]); }
      }
    }
  }
  return { comp, count: nc };
}

/**
 * @param {Array<{game:string, players:number[]}>} teamGames  candidate sets, five starters each
 * @param {Map<number,number>} officialStarts  playerId -> season starts
 * @returns classification per candidate edge plus feasibility diagnostics
 */
export function solve(teamGames, officialStarts) {
  const players = [...new Set(teamGames.flatMap((t) => t.players))];
  const pIdx = new Map(players.map((p, i) => [p, i]));
  const P = players.length, G = teamGames.length;
  const S = P + G, T = P + G + 1;
  const mf = new MaxFlow(P + G + 2);

  // Necessary conditions, checked before spending time on the flow.
  const demand = 5 * G;
  let supply = 0;
  for (const p of players) supply += officialStarts.get(p) || 0;
  const thin = teamGames.filter((t) => t.players.length < 5);
  const overClaim = players.filter((p) => (officialStarts.get(p) || 0) >
    teamGames.filter((t) => t.players.includes(p)).length);

  for (let i = 0; i < P; i++) mf.addEdge(S, i, officialStarts.get(players[i]) || 0);
  const edgeId = [];      // parallel to edges[]
  const edges = [];       // {p, g}
  for (let g = 0; g < G; g++) {
    for (const p of teamGames[g].players) {
      const i = pIdx.get(p);
      edgeId.push(mf.addEdge(i, P + g, 1));
      edges.push({ p, g, pi: i });
    }
    mf.addEdge(P + g, T, 5);
  }
  const flow = mf.run(S, T);
  const feasible = flow === demand && supply === demand;

  // Alternating digraph: selected edges point game->player, unselected point player->game.
  const adj = Array.from({ length: P + G }, () => []);
  const selected = new Uint8Array(edges.length);
  for (let e = 0; e < edges.length; e++) {
    const used = mf.cap[edgeId[e]] === 0;       // forward capacity consumed => x = 1
    selected[e] = used ? 1 : 0;
    if (used) adj[P + edges[e].g].push(edges[e].pi);
    else adj[edges[e].pi].push(P + edges[e].g);
  }
  const { comp } = scc(P + G, adj);

  const result = edges.map((e, i) => ({
    playerId: e.p, game: teamGames[e.g].game,
    status: comp[e.pi] === comp[P + e.g] ? 'AMBIGUOUS' : (selected[i] ? 'FORCED_TRUE' : 'FORCED_FALSE'),
    started: comp[e.pi] === comp[P + e.g] ? null : !!selected[i],
  }));

  return {
    feasible, flow, demand, supply,
    thinTeamGames: thin.length,
    overClaimingPlayers: overClaim.length,
    players: P, teamGames: G, candidateEdges: edges.length,
    edges: result,
  };
}
