// Shared empirical diagnostics for TULIP Evidence. These numbers are build-dependent and must
// never be hardcoded into UI/methodology prose. Both build-v3 and tulip-verify call this module so
// one executable implementation is the source of truth.
import { starterShare, TULIP_CONFIG } from './tulip.mjs';

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)) : 0; };
const smd = (a, b) => {
  const A = a.filter(fin), B = b.filter(fin);
  if (A.length < 3 || B.length < 3) return null;
  const p = Math.sqrt((sd(A) ** 2 + sd(B) ** 2) / 2);
  return p ? (mean(A) - mean(B)) / p : 0;
};
// Spearman is Pearson correlation of ranks. Ties must receive their average rank; the shortcut
// 1 - 6*sum(d^2)/(n(n^2-1)) is only exact when there are no ties, which is not guaranteed here.
const spearman = (a, b) => {
  const ids = [...a.keys()].filter((k) => b.has(k) && fin(a.get(k)) && fin(b.get(k)));
  if (ids.length < 5) return { rho: null, n: ids.length };
  const averageRanks = (m) => {
    const sorted = ids.slice().sort((x, y) => Number(m.get(y)) - Number(m.get(x)) || String(x).localeCompare(String(y)));
    const r = new Map();
    let i = 0;
    while (i < sorted.length) {
      let j = i + 1;
      const v = Number(m.get(sorted[i]));
      while (j < sorted.length && Number(m.get(sorted[j])) === v) j++;
      const avg = ((i + 1) + j) / 2; // 1-indexed inclusive ranks i+1..j
      for (let k = i; k < j; k++) r.set(sorted[k], avg);
      i = j;
    }
    return r;
  };
  const ra = averageRanks(a), rb = averageRanks(b);
  const xa = ids.map((id) => ra.get(id)), xb = ids.map((id) => rb.get(id));
  const ma = mean(xa), mb = mean(xb);
  const da = xa.map((x) => x - ma), db = xb.map((x) => x - mb);
  const den = Math.sqrt(da.reduce((s, x) => s + x * x, 0) * db.reduce((s, x) => s + x * x, 0));
  const rho = den ? da.reduce((s, x, i) => s + x * db[i], 0) / den : null;
  return { rho, n: ids.length };
};

function teamQuality(pool) {
  const rosters = {};
  for (const p of pool) (rosters[p.team] = rosters[p.team] || []).push(p);
  const teamNet = {};
  for (const [t, r] of Object.entries(rosters)) {
    const w = r.filter((x) => fin(x.netRtg) && fin(x.minutes));
    const tot = w.reduce((a, x) => a + x.minutes, 0);
    teamNet[t] = tot ? w.reduce((a, x) => a + x.netRtg * x.minutes, 0) / tot : 0;
  }
  return teamNet;
}

export function comparableSet(pool, c, target, cfg = TULIP_CONFIG) {
  return pool.filter((q) => q.playerId !== c.playerId
    && Math.abs(q.mpg - target) <= cfg.bandHalfWidth
    && (q.minutes || 0) >= cfg.minMinutes
    && (!fin(c.rateGrade) || !fin(q.rateGrade) || Math.abs(q.rateGrade - c.rateGrade) <= cfg.qualityBand)
    && (() => { const a = starterShare(c), b = starterShare(q);
      return !fin(a) || !fin(b) || Math.abs(a - b) <= (cfg.starterShareBand ?? 1e9); })());
}

export function balanceSnapshot(players, cfg = TULIP_CONFIG) {
  const pool = players.filter((p) => p.appeared && p.skillProfile);
  const tq = teamQuality(pool);
  const cov = {
    rateGrade: (p) => p.rateGrade, mpg: (p) => p.mpg, gp: (p) => p.gp, minutes: (p) => p.minutes,
    usage: (p) => p.usg, age: (p) => p.ageOpeningNight ?? p.age, heightIn: (p) => p.heightInches,
    starterShare: (p) => starterShare(p), teamQuality: (p) => tq[p.team],
    selfCreation: (p) => p.skillProfile?.selfCreation, rimProtection: (p) => p.skillProfile?.rimProtection,
  };
  function balance(oneCfg, bandFilter = null) {
    const acc = Object.fromEntries(Object.keys(cov).map((k) => [k, { c: [], m: [] }]));
    let n = 0;
    for (const c of pool) {
      if (!fin(c.mpg) || c.mpg > oneCfg.maxCurrentMpgForExpansion || (c.minutes || 0) < 200) continue;
      const target = Math.min(34, Math.round(c.mpg) + 8);
      if (bandFilter && !bandFilter(target)) continue;
      const comps = comparableSet(pool, c, target, oneCfg);
      if (comps.length < oneCfg.minComparables) continue;
      n++;
      for (const [k, f] of Object.entries(cov)) {
        const cv = f(c); if (fin(cv)) acc[k].c.push(Number(cv));
        for (const q of comps) { const qv = f(q); if (fin(qv)) acc[k].m.push(Number(qv)); }
      }
    }
    return { n, smds: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, smd(v.c, v.m)])) };
  }
  const before = balance({ ...cfg, starterShareBand: 1e9 });
  const after = balance(cfg);
  const bands = [];
  for (const [lo, hi] of [[14, 20], [20, 24], [24, 28], [28, 32], [32, 40]]) {
    const r = balance(cfg, (t) => t >= lo && t < hi);
    if (r.n) bands.push({ lo, hi, ...r });
  }
  const starterVals = bands.map((b) => ({ band: `${b.lo}-${b.hi}`, n: b.n, smd: b.smds.starterShare }))
    .filter((x) => x.smd !== null);
  const worst = starterVals.slice().sort((a, b) => Math.abs(b.smd) - Math.abs(a.smd))[0] || null;
  return {
    candidatesMatched: { before: before.n, after: after.n },
    overallSmd: after.smds,
    beforeSmd: before.smds,
    bands: bands.map((b) => ({ band: `${b.lo}-${b.hi}`, n: b.n, smds: b.smds })),
    starterContext: {
      pooledSmd: after.smds.starterShare,
      worstBand: worst?.band || null,
      worstBandN: worst?.n || null,
      worstBandSmd: worst?.smd ?? null,
    },
  };
}

export function outcomeSensitivitySnapshot(players, cfg = TULIP_CONFIG) {
  const pool = players.filter((p) => p.appeared && p.skillProfile);
  const targets = {
    netRtg: (p) => p.netRtg,
    pie: (p) => (fin(p.pie) ? p.pie * 100 : null),
    rateComposite: (p) => {
      const c = p.components || {};
      const parts = ['scoring', 'playmaking', 'rebounding', 'defense', 'efficiency']
        .map((k) => c[k]).filter(fin);
      return parts.length >= 4 ? mean(parts) : null;
    },
    rateGrade: (p) => p.rateGrade,
  };
  function rankUnder(targetFn) {
    const out = new Map();
    for (const c of pool) {
      if (!fin(c.mpg) || c.mpg > cfg.maxCurrentMpgForExpansion || (c.minutes || 0) < 200) continue;
      const target = Math.min(34, Math.round(c.mpg) + 8);
      const comps = comparableSet(pool, c, target, cfg);
      if (comps.length < cfg.minComparables) continue;
      const vals = comps.map(targetFn).filter(fin);
      if (vals.length < cfg.minComparables) continue;
      const ref = pool.filter((q) => (q.mpg || 0) >= 10 && (q.minutes || 0) >= cfg.displacedMinMinutes)
        .map(targetFn).filter(fin).sort((a, b) => a - b);
      const med = ref.length ? ref[Math.floor(ref.length / 2)] : 0;
      out.set(c.playerId, mean(vals) - med);
    }
    return out;
  }
  const ranks = Object.fromEntries(Object.entries(targets).map(([k, f]) => [k, rankUnder(f)]));
  const keys = Object.keys(targets);
  const matrix = {};
  for (const a of keys) {
    matrix[a] = {};
    for (const b of keys) matrix[a][b] = spearman(ranks[a], ranks[b]);
  }
  const topK = (m, k = 20) => new Set([...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, k).map(([id]) => id));
  const base = topK(ranks.netRtg);
  const top20Overlap = {};
  for (const k of keys.filter((x) => x !== 'netRtg')) top20Overlap[k] = [...topK(ranks[k])].filter((id) => base.has(id)).length;
  const vsNetRtg = Object.fromEntries(keys.filter((x) => x !== 'netRtg').map((k) => [k, matrix.netRtg[k].rho]));
  const finiteRhos = Object.values(vsNetRtg).filter(fin).map(Number);
  return {
    vsNetRtg,
    spearmanRange: finiteRhos.length ? [Math.min(...finiteRhos), Math.max(...finiteRhos)] : [null, null],
    top20Overlap,
    matrix,
  };
}

export function tulipDiagnostics(players, cfg = TULIP_CONFIG) {
  return { balance: balanceSnapshot(players, cfg), outcomeSensitivity: outcomeSensitivitySnapshot(players, cfg) };
}
