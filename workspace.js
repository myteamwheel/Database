/* Analysis workspace: modes beyond the table. Loaded after app.js and reuses its helpers.
   Database | Player | Compare | Scatter | Similarity | Team Fit are real tools, not presets. */
(() => {
  const $ = (id) => document.getElementById(id);
  const fin = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 1) => (fin(v) ? Number(v).toFixed(d) : '—');
  /** Grades are capped at 9.9999; rounding to 2dp would print 10.00, which the scale cannot reach. */
  const gnum = (v, d = 2) => (fin(v) ? (Math.floor(Number(v) * 10 ** d) / 10 ** d).toFixed(d) : '—');
  const pctS = (v) => (fin(v) ? `${(Number(v) * 100).toFixed(1)}%` : '—');
  const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  let MODE = 'database';
  const state = { player: null, scatterX: 'usg', scatterY: 'ts', scatterSize: '', scatterColor: 'positionFamily',
                  simPlayer: null, simLeague: 'same', simMinMin: 300, team: null,
                  tulipPlayer: null, tulipTarget: null };

  const league = () => window.__wsLeague();
  const players = () => (window.DATA?.leagues?.[league()] || []).filter((p) => p.appeared);
  const byId = (id) => players().find((p) => p.playerId === id);

  /* ------------------------------------------------------------- mode nav */
  const MODES = [
    ['database', 'Database'], ['player', 'Player'], ['compare', 'Compare'],
    ['scatter', 'Scatter'], ['similarity', 'Similarity'], ['teamfit', 'Team Fit'],
    ['tulip', 'TULIP'],
  ];

  function renderNav() {
    $('modeNav').innerHTML = MODES.map(([k, label]) =>
      `<button class="mode-tab${MODE === k ? ' active' : ''}" data-mode="${k}">${esc(label)}</button>`).join('');
    document.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = () => { MODE = b.dataset.mode; render(); };
    });
  }

  function render() {
    renderNav();
    const isDb = MODE === 'database';
    document.querySelectorAll('.db-only').forEach((e) => { e.style.display = isDb ? '' : 'none'; });
    $('workspace').style.display = isDb ? 'none' : '';
    if (isDb) { window.__wsRender(); return; }
    const fn = { player: viewPlayer, compare: viewCompare, scatter: viewScatter,
                 similarity: viewSimilarity, teamfit: viewTeamFit, tulip: viewTulip }[MODE];
    $('workspace').innerHTML = fn ? fn() : '';
    if (fn === viewScatter) drawScatter();
    if (fn === viewTulip) drawFrontier();
    wire();
  }

  /* ------------------------------------------------- shared UI fragments */
  const bar = (label, v, extra = '') =>
    `<div class="pbar"><span class="pbar-l">${esc(label)}</span>
      <span class="pbar-t"><i style="width:${fin(v) ? Math.max(1, Math.min(100, v)) : 0}%"></i></span>
      <b>${fin(v) ? Number(v).toFixed(0) : '—'}</b>${extra}</div>`;

  const playerPicker = (id, selected, label) =>
    `<label>${esc(label)}<select id="${id}">${
      players().slice().sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => `<option value="${esc(p.playerId)}"${p.playerId === selected ? ' selected' : ''}>${esc(p.name)} — ${esc(p.team)}</option>`).join('')
    }</select></label>`;

  /** Numeric fields for scatter axes, taken from the catalog rather than a hand-kept list. */
  function numericFields() {
    const out = [];
    const sample = players()[0] || {};
    for (const k of ['grade', 'rateGrade', 'magnitudeGrade', 'reliabilityWeight', 'gradeCoverage',
      'gp', 'mpg', 'minutes', 'pts', 'reb', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov',
      'ts', 'efg', 'fgPct', 'fg3Pct', 'ftPct', 'usg', 'astPct', 'astTo', 'orebPct', 'drebPct',
      'rebPct', 'offRtg', 'defRtg', 'netRtg', 'pie', 'pace', 'age', 'ageOpeningNight', 'heightInches', 'weight']) {
      if (fin(sample[k]) || players().some((p) => fin(p[k]))) out.push({ key: k, label: window.__wsLabel(k) });
    }
    for (const [k, v] of Object.entries(sample.components || {})) out.push({ key: 'components.' + k, label: 'Component: ' + k });
    for (const [k] of Object.entries(sample.skillProfile || {})) out.push({ key: 'skill.' + k, label: 'Skill: ' + k });
    return out;
  }
  const valueOf = (p, key) => {
    if (key.startsWith('skill.')) return p.skillProfile?.[key.slice(6)] ?? null;
    if (key.startsWith('components.')) return p.components?.[key.slice(11)] ?? null;
    return p[key] ?? null;
  };

  /* ---------------------------------------------------------- PLAYER MODE */
  function viewPlayer() {
    const p = byId(state.player) || players()[0];
    if (!p) return '<p class="loading">No players.</p>';
    state.player = p.playerId;
    const sp = p.skillProfile || {};
    const cr = p.cohortRanks || {};
    const splits = ['home', 'road', 'wins', 'losses', 'starter', 'bench', 'preallstar', 'postallstar', 'clutch'];
    const sv = (name, f) => p.stats?.[`sit_${name}_${f}`];
    const months = [1, 2, 3, 4, 5, 6, 7].filter((m) => fin(sv(`month${m}`, 'gp')));

    const strengths = Object.entries(sp).filter(([, v]) => fin(v)).sort((a, b) => b[1] - a[1]);
    const arche = (p.archetypes || []).map((a) =>
      `<div class="arche"><b>${esc(a.name)}</b><span>${a.score}</span>
        <p class="tiny">${a.drivers.map((d) => `${esc(d.axis)} ${d.percentile.toFixed(0)}th`).join(' · ')}</p></div>`).join('');

    return `
    <div class="ws-head">
      <div>${playerPicker('wsPlayerSel', p.playerId, 'Player')}</div>
      <div class="ws-title"><h2>${esc(p.name)}</h2>
        <p class="tiny">${esc(p.leagueLabel)} · ${esc(p.team)} · ${esc(p.position || '—')} · ${p.ageOpeningNight ?? p.age ?? '—'} yrs · ${esc(p.height || '—')} · ${p.gp} games · ${num(p.mpg)} mpg</p></div>
    </div>

    <div class="ws-grid">
      <div class="ws-card"><div class="k">Grade</div><div class="v grade">${num(p.grade, 4)}</div>
        <p class="tiny">#${p.rank} of ${window.DATA.counts[p.league]} · per-game standing</p></div>
      <div class="ws-card"><div class="k">Rate Grade</div><div class="v">${num(p.rateGrade, 4)}</div>
        <p class="tiny">per 36 minutes</p></div>
      <div class="ws-card"><div class="k">Magnitude</div><div class="v">${num(p.magnitudeGrade, 4)}</div>
        <p class="tiny">distance from normal</p></div>
      <div class="ws-card"><div class="k">Reliability</div><div class="v">${num(p.reliabilityWeight)}</div>
        <p class="tiny">coverage ${num(p.gradeCoverage)}%</p></div>
      ${cr.position ? `<div class="ws-card"><div class="k">Among ${esc(p.positionFamily)}</div><div class="v">#${cr.position.rank}</div><p class="tiny">of ${cr.position.of}</p></div>` : ''}
      ${cr.team ? `<div class="ws-card"><div class="k">On ${esc(p.team)}</div><div class="v">#${cr.team.rank}</div><p class="tiny">of ${cr.team.of}</p></div>` : ''}
    </div>

    <div class="ws-cols">
      <section><h3>Grade components</h3>
        ${Object.entries(p.components || {}).map(([k, v]) =>
          bar(k, v, ` <span class="tiny">${esc(p.gradeCoverageDetail?.[k] || '')}</span>`)).join('')}
      </section>
      <section><h3>Skill profile <span class="tiny">percentile within ${esc(p.leagueLabel)}</span></h3>
        ${Object.entries(sp).map(([k, v]) => bar(k, v)).join('')}
      </section>
    </div>

    <div class="ws-cols">
      <section><h3>Strengths</h3>${strengths.slice(0, 5).map(([k, v]) => bar(k, v)).join('') || '<p class="tiny">—</p>'}</section>
      <section><h3>Weaknesses</h3>${strengths.slice(-5).reverse().map(([k, v]) => bar(k, v)).join('') || '<p class="tiny">—</p>'}</section>
    </div>

    <h3>Archetypes <span class="tiny">rule-based, with the axes that drove each score</span></h3>
    <div class="arche-row">${arche || '<p class="tiny">Not enough profile data.</p>'}</div>

    ${p.ownTeamFit ? `<h3>Fit with ${esc(p.team)}</h3>
      <div class="ws-card wide"><div class="v">${p.ownTeamFit.score}/100</div>
        <p class="tiny">${[...p.ownTeamFit.strengths, ...p.ownTeamFit.weaknesses].map(esc).join('<br>')}</p>
        <p class="tiny">Fit is not quality — it measures how well this profile answers what the roster lacks.</p></div>` : ''}

    <h3>Situational splits</h3>
    <div class="table-wrap"><table class="compare-table"><thead><tr><th class="left">Split</th>
      <th>G</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>TS%</th><th>USG%</th><th>PIE</th><th>NetRtg</th></tr></thead><tbody>
      ${splits.filter((s) => fin(sv(s, 'gp'))).map((s) => `<tr><td class="left">${esc(s)}</td>
        <td>${num(sv(s, 'gp'), 0)}</td><td>${num(sv(s, 'mpg'))}</td><td>${num(sv(s, 'pts'))}</td>
        <td>${num(sv(s, 'reb'))}</td><td>${num(sv(s, 'ast'))}</td><td>${pctS(sv(s, 'ts'))}</td>
        <td>${pctS(sv(s, 'usg_pct'))}</td><td>${pctS(sv(s, 'pie'))}</td><td>${num(sv(s, 'net_rating'))}</td></tr>`).join('')}
    </tbody></table></div>

    ${months.length ? `<h3>Month by month <span class="tiny">season-relative; month 1 is the opening month</span></h3>
      ${sparkline(months.map((m) => sv(`month${m}`, 'pts')), months.map((m) => 'M' + m))}
      <div class="table-wrap"><table class="compare-table"><thead><tr><th class="left">Month</th>
        <th>G</th><th>PTS</th><th>TS%</th><th>USG%</th><th>PIE</th></tr></thead><tbody>
        ${months.map((m) => `<tr><td class="left">M${m}</td><td>${num(sv(`month${m}`, 'gp'), 0)}</td>
          <td>${num(sv(`month${m}`, 'pts'))}</td><td>${pctS(sv(`month${m}`, 'ts'))}</td>
          <td>${pctS(sv(`month${m}`, 'usg_pct'))}</td><td>${pctS(sv(`month${m}`, 'pie'))}</td></tr>`).join('')}
      </tbody></table></div>` : ''}

    ${(p.teams || []).length > 1 ? `<h3>Team history</h3><div class="table-wrap"><table class="compare-table">
      <thead><tr><th class="left">Team</th><th>G</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>FG%</th><th>+/-</th></tr></thead>
      <tbody>${p.teams.map((s) => `<tr><td class="left">${esc(s.team)}</td><td>${s.gp}</td><td>${num(s.mpg)}</td>
        <td>${num(s.pts)}</td><td>${num(s.reb)}</td><td>${num(s.ast)}</td><td>${pctS(s.fgPct)}</td><td>${num(s.plusMinus)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}

    ${p.nbaTranslation && Object.keys(p.nbaTranslation).length ? translationBlock(p) : ''}
    <div class="ws-actions"><button class="button" id="wsFindSimilar">Find similar players</button></div>`;
  }

  function translationBlock(p) {
    const t = p.nbaTranslation;
    const rows = ['pts', 'reb', 'ast', 'mpg', 'ts', 'usg'].filter((k) => t[k]);
    return `<h3>Exploratory NBA equivalent</h3>
      <div class="table-wrap"><table class="compare-table"><thead><tr>
        <th class="left">Stat</th><th>G League</th><th>Est. NBA</th><th>Range</th><th>Based on</th></tr></thead><tbody>
        ${rows.map((k) => `<tr><td class="left">${esc(window.__wsLabel(k))}</td>
          <td>${num(p[k], 2)}</td><td><b>${num(t[k].estimate, 2)}</b></td>
          <td class="tiny">${num(t[k].low, 2)} – ${num(t[k].high, 2)}</td><td class="tiny">${t[k].basedOn} crossovers</td></tr>`).join('')}
      </tbody></table></div>
      <p class="tiny"><b>Exploratory only.</b> ${esc(window.DATA.analysis.translation.caveat)}</p>`;
  }

  /** Tiny inline SVG trend, enough to read a shape without a chart library. */
  function sparkline(values, labels) {
    const v = values.map((x) => (fin(x) ? Number(x) : null));
    const ok = v.filter(fin);
    if (ok.length < 2) return '';
    const min = Math.min(...ok), max = Math.max(...ok), span = max - min || 1;
    const w = 520, h = 90, pad = 24;
    const pts = v.map((x, i) => {
      const px = pad + (i * (w - pad * 2)) / Math.max(1, v.length - 1);
      const py = fin(x) ? h - pad - ((x - min) / span) * (h - pad * 2) : null;
      return { px, py, x };
    });
    const path = pts.filter((q) => q.py !== null).map((q, i) => `${i ? 'L' : 'M'}${q.px.toFixed(1)},${q.py.toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="trend">
      <path d="${path}" fill="none" stroke="currentColor" stroke-width="2"/>
      ${pts.filter((q) => q.py !== null).map((q) => `<circle cx="${q.px.toFixed(1)}" cy="${q.py.toFixed(1)}" r="3"/>`).join('')}
      ${pts.map((q, i) => `<text x="${q.px.toFixed(1)}" y="${h - 4}" text-anchor="middle" class="sparklab">${esc(labels[i])}</text>`).join('')}
      <text x="2" y="12" class="sparklab">${max.toFixed(1)}</text><text x="2" y="${h - pad + 4}" class="sparklab">${min.toFixed(1)}</text>
    </svg>`;
  }

  /* --------------------------------------------------------- COMPARE MODE */
  function viewCompare() {
    const sel = window.__wsCompared();
    const ps = sel.map(byId).filter(Boolean);
    if (ps.length < 2) return `<p class="loading">Tick 2–5 players in the Database table, then return here.</p>`;
    const metrics = ['grade', 'rateGrade', 'magnitudeGrade', 'gp', 'mpg', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov',
      'ts', 'efg', 'usg', 'astPct', 'orebPct', 'drebPct', 'offRtg', 'defRtg', 'netRtg', 'pie'];
    const cross = new Set(ps.map((p) => p.league)).size > 1;
    const best = (k) => {
      const vals = ps.map((p) => valueOf(p, k)).filter(fin).map(Number);
      if (!vals.length) return null;
      const lower = ['tov', 'defRtg'].includes(k);
      return lower ? Math.min(...vals) : Math.max(...vals);
    };
    return `<h2>Compare</h2>
      ${cross ? '<p class="tiny"><b>Cross-league comparison.</b> Each league is graded against its own population, so grades are not on a shared scale.</p>' : ''}
      <div class="table-wrap"><table class="compare-table"><thead><tr><th class="left">Metric</th>
        ${ps.map((p) => `<th>${esc(p.name)}<span class="tiny">${esc(p.team)} · ${esc(p.position || '')}</span></th>`).join('')}</tr></thead>
        <tbody>${metrics.filter((k) => ps.some((p) => fin(valueOf(p, k)))).map((k) => {
          const b = best(k);
          return `<tr><td class="left">${esc(window.__wsLabel(k))}</td>${ps.map((p) => {
            const v = valueOf(p, k);
            const win = fin(v) && b !== null && Number(v) === b;
            return `<td class="${win ? 'winner' : ''}">${window.__wsFmt(v, k)}</td>`;
          }).join('')}</tr>`;
        }).join('')}</tbody></table></div>
      <h3>Skill profile</h3>
      ${Object.keys(ps[0].skillProfile || {}).map((axis) => `<div class="cmp-axis"><span class="pbar-l">${esc(axis)}</span>
        ${ps.map((p) => `<span class="pbar-t" title="${esc(p.name)}"><i style="width:${p.skillProfile?.[axis] ?? 0}%"></i></span>`).join('')}</div>`).join('')}
      <p class="tiny">Bars are within-league percentiles, in the order the players appear above.</p>`;
  }

  /* --------------------------------------------------------- SCATTER MODE */
  function viewScatter() {
    const f = numericFields();
    const opt = (sel) => f.map((x) => `<option value="${esc(x.key)}"${x.key === sel ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
    const presets = [['usg', 'ts', 'Usage vs efficiency'], ['pts', 'ts', 'Scoring vs efficiency'],
      ['astPct', 'tov', 'Assist rate vs turnovers'], ['ageOpeningNight', 'grade', 'Age vs grade'],
      ['reliabilityWeight', 'grade', 'Reliability vs grade'], ['grade', 'magnitudeGrade', 'Grade vs magnitude']];
    return `<h2>Scatter &amp; correlation</h2>
      <div class="ws-controls">
        <label>X<select id="scX">${opt(state.scatterX)}</select></label>
        <label>Y<select id="scY">${opt(state.scatterY)}</select></label>
        <label>Bubble size<select id="scSize"><option value="">none</option>${opt(state.scatterSize)}</select></label>
        <label>Colour by<select id="scColor">
          ${['positionFamily', 'team', 'ageBand', 'primaryArchetype'].map((k) => `<option value="${k}"${k === state.scatterColor ? ' selected' : ''}>${k}</option>`).join('')}
        </select></label>
      </div>
      <div class="ws-controls">${presets.map(([x, y, l]) => `<button class="button secondary small" data-preset="${x}|${y}">${esc(l)}</button>`).join('')}</div>
      <div id="scStats" class="tiny"></div>
      <canvas id="scCanvas" width="1100" height="560" style="width:100%;max-width:1100px"></canvas>
      <div id="scHover" class="tiny"></div>
      <div id="scOutliers"></div>`;
  }

  function drawScatter() {
    const cv = $('scCanvas'); if (!cv) return;
    const ctx = cv.getContext('2d');
    const list = window.__wsFiltered().filter((p) => p.appeared);
    const pts = list.map((p) => ({ p, x: Number(valueOf(p, state.scatterX)), y: Number(valueOf(p, state.scatterY)),
      s: state.scatterSize ? Number(valueOf(p, state.scatterSize)) : null }))
      .filter((q) => fin(q.x) && fin(q.y));
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (pts.length < 2) { $('scStats').textContent = 'Not enough data for these axes.'; return; }

    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    const mean = (a) => a.reduce((m, v) => m + v, 0) / a.length;
    const mx = mean(xs), my = mean(ys);
    const sx = Math.sqrt(mean(xs.map((v) => (v - mx) ** 2))), sy = Math.sqrt(mean(ys.map((v) => (v - my) ** 2)));
    const r = sx && sy ? mean(pts.map((q) => (q.x - mx) * (q.y - my))) / (sx * sy) : 0;

    const pad = 54, W = cv.width, H = cv.height;
    const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    const PX = (v) => pad + ((v - xmin) / (xmax - xmin || 1)) * (W - pad * 2);
    const PY = (v) => H - pad - ((v - ymin) / (ymax - ymin || 1)) * (H - pad * 2);

    const css = getComputedStyle(document.body);
    const line = css.getPropertyValue('--line') || '#273142';
    const muted = css.getPropertyValue('--muted') || '#9aabba';
    ctx.strokeStyle = line; ctx.fillStyle = muted; ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, W - pad * 2, H - pad * 2);
    ctx.font = '12px system-ui';
    for (let i = 0; i <= 4; i++) {
      const gx = xmin + ((xmax - xmin) * i) / 4, gy = ymin + ((ymax - ymin) * i) / 4;
      ctx.fillText(gx.toFixed(gx > 10 ? 0 : 2), PX(gx) - 12, H - pad + 18);
      ctx.fillText(gy.toFixed(gy > 10 ? 0 : 2), 6, PY(gy) + 4);
    }

    const groupOf = (p) => state.scatterColor === 'ageBand'
      ? (() => { const a = p.ageOpeningNight ?? p.age; return a == null ? '—' : a <= 22 ? '≤22' : a <= 26 ? '23-26' : a <= 30 ? '27-30' : '31+'; })()
      : (p[state.scatterColor] ?? '—');
    const groups = [...new Set(pts.map((q) => groupOf(q.p)))];
    const hue = (g) => `hsl(${(groups.indexOf(g) * 67) % 360} 70% 60%)`;
    const smax = state.scatterSize ? Math.max(...pts.map((q) => (fin(q.s) ? q.s : 0))) || 1 : 1;

    for (const q of pts) {
      const rad = state.scatterSize && fin(q.s) ? 2 + 9 * Math.sqrt(Math.max(0, q.s) / smax) : 4;
      ctx.beginPath(); ctx.arc(PX(q.x), PY(q.y), rad, 0, Math.PI * 2);
      ctx.fillStyle = hue(groupOf(q.p)); ctx.globalAlpha = 0.72; ctx.fill(); ctx.globalAlpha = 1;
      q._px = PX(q.x); q._py = PY(q.y); q._r = rad;
    }
    // Least-squares trend line.
    const b = sx ? mean(pts.map((q) => (q.x - mx) * (q.y - my))) / (sx * sx) : 0;
    const a = my - b * mx;
    ctx.strokeStyle = '#63b3ff'; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(PX(xmin), PY(a + b * xmin)); ctx.lineTo(PX(xmax), PY(a + b * xmax)); ctx.stroke();

    $('scStats').innerHTML = `<b>r = ${r.toFixed(3)}</b> · n = ${pts.length} · trend y = ${b.toFixed(3)}x + ${a.toFixed(2)}
      · colour: ${groups.slice(0, 8).map((g) => `<span style="color:${hue(g)}">■</span> ${esc(g)}`).join(' ')}`;

    // Outliers: largest residuals against the trend.
    const resid = pts.map((q) => ({ q, e: Math.abs(q.y - (a + b * q.x)) })).sort((u, v) => v.e - u.e).slice(0, 8);
    $('scOutliers').innerHTML = `<h3>Largest residuals</h3><p class="tiny">${resid.map((u) =>
      `${esc(u.q.p.name)} (${u.q.x.toFixed(2)}, ${u.q.y.toFixed(2)})`).join(' · ')}</p>`;

    cv.onmousemove = (ev) => {
      const rect = cv.getBoundingClientRect();
      const cx = (ev.clientX - rect.left) * (cv.width / rect.width);
      const cy = (ev.clientY - rect.top) * (cv.height / rect.height);
      const hit = pts.find((q) => Math.hypot(q._px - cx, q._py - cy) <= q._r + 3);
      $('scHover').textContent = hit
        ? `${hit.p.name} — ${window.__wsLabel(state.scatterX)} ${hit.x.toFixed(2)}, ${window.__wsLabel(state.scatterY)} ${hit.y.toFixed(2)}`
        : '';
    };
    cv.onclick = (ev) => {
      const rect = cv.getBoundingClientRect();
      const cx = (ev.clientX - rect.left) * (cv.width / rect.width);
      const cy = (ev.clientY - rect.top) * (cv.height / rect.height);
      const hit = pts.find((q) => Math.hypot(q._px - cx, q._py - cy) <= q._r + 3);
      if (hit) { state.player = hit.p.playerId; MODE = 'player'; render(); }
    };
  }

  /* ------------------------------------------------------ SIMILARITY MODE */
  function simScore(a, b) {
    const W = window.DATA.analysis.similarityWeights;
    let acc = 0, wsum = 0; const axes = [];
    for (const [axis, w] of Object.entries(W)) {
      const x = a?.[axis], y = b?.[axis];
      if (!fin(x) || !fin(y)) continue;
      const diff = x - y;
      acc += w * diff * diff; wsum += w;
      axes.push({ axis, diff: Math.abs(diff) });
    }
    if (!wsum) return null;
    const d = Math.sqrt(acc / wsum);
    axes.sort((p, q) => p.diff - q.diff);
    return { score: Math.max(0, Math.min(100, 100 * (1 - d / 100))), axes };
  }

  function viewSimilarity() {
    const p = byId(state.simPlayer) || byId(state.player) || players()[0];
    if (!p) return '<p class="loading">No players.</p>';
    state.simPlayer = p.playerId;
    const pool = [];
    const add = (lg) => (window.DATA.leagues[lg] || []).filter((q) => q.appeared && q.skillProfile
      && q.playerId !== p.playerId && (q.minutes || 0) >= state.simMinMin)
      .forEach((q) => pool.push(q));
    if (state.simLeague === 'same') add(p.league);
    else if (state.simLeague === 'other') add(p.league === 'NBA' ? 'GLEAGUE' : 'NBA');
    else { add('NBA'); add('GLEAGUE'); }

    const results = pool.map((q) => ({ q, s: simScore(p.skillProfile, q.skillProfile) }))
      .filter((x) => x.s).sort((a, b) => b.s.score - a.s.score).slice(0, 25);

    return `<h2>Similarity search</h2>
      <div class="ws-controls">
        ${playerPicker('simSel', p.playerId, 'Player')}
        <label>Pool<select id="simLeague">
          <option value="same"${state.simLeague === 'same' ? ' selected' : ''}>Same league</option>
          <option value="other"${state.simLeague === 'other' ? ' selected' : ''}>Other league</option>
          <option value="both"${state.simLeague === 'both' ? ' selected' : ''}>Both</option>
        </select></label>
        <label>Min total minutes<input id="simMin" type="number" step="50" value="${state.simMinMin}"></label>
      </div>
      <p class="tiny">${esc(window.DATA.analysis.similarityMethod)}</p>
      <div class="table-wrap"><table class="compare-table"><thead><tr>
        <th class="left">Player</th><th>League</th><th>Similar</th><th class="left">Most similar on</th><th class="left">Biggest differences</th>
      </tr></thead><tbody>
        ${results.map(({ q, s }) => `<tr>
          <td class="left"><button class="player-link" data-goto="${esc(q.playerId)}">${esc(q.name)}</button>
            <span class="tiny">${esc(q.team)} · ${esc(q.position || '')} · grade ${gnum(q.grade)}</span></td>
          <td>${q.league === 'NBA' ? 'NBA' : 'G'}</td>
          <td><b>${s.score.toFixed(1)}%</b></td>
          <td class="left tiny">${s.axes.slice(0, 3).map((a) => esc(a.axis)).join(', ')}</td>
          <td class="left tiny">${s.axes.slice(-3).reverse().map((a) => `${esc(a.axis)} (${a.diff.toFixed(0)})`).join(', ')}</td>
        </tr>`).join('')}
      </tbody></table></div>
      ${state.simLeague !== 'same' ? '<p class="tiny">Cross-league similarity compares within-league percentiles, so it describes similar <em>roles</em>, not equal ability.</p>' : ''}`;
  }

  /* -------------------------------------------------------- TEAM FIT MODE */
  function viewTeamFit() {
    const teams = window.DATA.analysis.teams[league()] || {};
    const names = Object.keys(teams).sort();
    const t = teams[state.team] || teams[names[0]];
    if (!t) return '<p class="loading">No team data.</p>';
    state.team = t.team;
    const needs = Object.entries(t.needs).sort((a, b) => b[1].need - a[1].need);
    return `<h2>Team fit — ${esc(t.team)}</h2>
      <div class="ws-controls"><label>Team<select id="tfTeam">
        ${names.map((n) => `<option value="${esc(n)}"${n === t.team ? ' selected' : ''}>${esc(n)}</option>`).join('')}
      </select></label><span class="tiny">${t.rosterSize} players counted toward this roster</span></div>
      <div class="ws-cols">
        <section><h3>Roster needs <span class="tiny">100 = biggest gap</span></h3>
          ${needs.map(([, v]) => bar(v.label, v.need)).join('')}</section>
        <section><h3>Roster strengths <span class="tiny">minutes-weighted percentile</span></h3>
          ${needs.slice().reverse().map(([, v]) => bar(v.label, v.strength)).join('')}</section>
      </div>
      <h3>Best fits</h3>
      <p class="tiny">Fit is <b>not</b> quality. A lower-graded player can fit better because he supplies what this roster lacks.</p>
      <div class="table-wrap"><table class="compare-table"><thead><tr>
        <th class="left">Player</th><th>Grade</th><th>Fit</th><th class="left">Why</th></tr></thead><tbody>
        ${t.topFits.slice(0, 30).map((f) => `<tr>
          <td class="left"><button class="player-link" data-goto="${esc(f.playerId)}">${esc(f.name)}</button></td>
          <td>${gnum(f.grade)}</td><td><b>${f.score}/100</b></td>
          <td class="left tiny">${[...(f.strengths || []), ...(f.weaknesses || [])].map(esc).join('<br>')}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  /* ------------------------------------------------------------ TULIP MODE */
  /**
   * TULIP is a role-change question, so the UI leads with the scenario, then the evidence, then
   * the decision. The single most important visual job is separating "the model expects decline"
   * from "the model has no evidence" — they are drawn differently and never merged.
   */
  function viewTulip() {
    const cands = players().filter((p) => p.tulip)
      .sort((a, b) => {
        const av = a.tulip.card?.rotation?.leagueReferencedDelta ?? -99;
        const bv = b.tulip.card?.rotation?.leagueReferencedDelta ?? -99;
        return bv - av;
      });
    const p = byId(state.tulipPlayer) || cands.find((x) => !x.tulip.card.abstain) || cands[0];
    if (!p) return '<p class="loading">No TULIP data for this league.</p>';
    state.tulipPlayer = p.playerId;
    const t = p.tulip;
    const target = state.tulipTarget ?? t.defaultTarget;
    // Frontier band matching the chosen target, so the card and the chart agree.
    const band = t.frontier.reduce((best, f) =>
      (Math.abs(f.mpg - target) < Math.abs((best?.mpg ?? 1e9) - target) ? f : best), null);
    const card = t.card;
    const rot = card.rotation;
    const rsr = t.roleScaleResponse || {};

    const scenario = `
      <div class="ws-controls">
        ${playerPicker('tuPlayer', p.playerId, 'Candidate')}
        <label>Target role
          <select id="tuTarget">${t.frontier.map((f) =>
            `<option value="${f.mpg}"${f.mpg === target ? ' selected' : ''}>${f.mpg} MPG${f.abstain ? ' — no evidence' : ''}</option>`).join('')}</select>
        </label>
        <div class="ws-card"><div class="k">Current role</div><div class="v">${num(p.mpg)}<span class="tiny"> mpg · ${p.gp} g</span></div></div>
        <div class="ws-card"><div class="k">Change</div><div class="v">${target > p.mpg ? '+' : ''}${num(target - p.mpg)}<span class="tiny"> mpg</span></div></div>
      </div>`;

    if (band && band.abstain) {
      return scenario + `<div class="tulip-abstain">
        <div class="eyebrow">INSUFFICIENT EVIDENCE</div>
        <h3>No projection at ${band.mpg} MPG</h3>
        <p>${esc(band.abstainReason || 'Not enough comparable players occupied this role.')}</p>
        <p class="tiny">This is <b>not</b> a prediction of decline. TULIP abstains rather than
        manufacturing a number when the evidence is not there.</p>
      </div>` + frontierBlock(t, target) + comparablesNote();
    }

    const proj = band && !band.abstain ? band : null;
    const verdictClass = rot && !rot.abstain
      ? (rot.verdict === 'EXPAND ROLE' ? 'v-good' : rot.verdict === 'DO NOT EXPAND' ? 'v-bad' : 'v-mid') : 'v-mid';

    return scenario + `
      <div class="ws-grid">
        <div class="ws-card"><div class="k">Projected impact at ${target} mpg</div>
          <div class="v">${proj ? num(proj.projectedImpact, 2) : '—'}</div>
          <p class="tiny">${proj && proj.interval ? `80% interval ${num(proj.interval[0], 2)} to ${num(proj.interval[1], 2)}` : ''}</p></div>
        <div class="ws-card"><div class="k">TULIP Support</div><div class="v">${proj ? proj.support : '—'}<span class="tiny">/100</span></div>
          <p class="tiny">${proj ? `${proj.comparables} comparables · effective n ${num(proj.effectiveN, 1)} · mean similarity ${num(proj.meanSimilarity, 1)}` : ''}</p></div>
        <div class="ws-card"><div class="k">Evidence tier</div><div class="v">${esc(card.evidenceTier?.tier || '—')}</div>
          <p class="tiny">${esc(card.evidenceTier?.label || '')}</p></div>
        <div class="ws-card"><div class="k">Role-Scale Response</div>
          <div class="v">${esc(rsr.response || '—')}</div>
          <p class="tiny">${fin(rsr.slopePer10Min) ? `${rsr.slopePer10Min > 0 ? '+' : ''}${rsr.slopePer10Min} per 10 mpg` : 'not enough supported bands'}</p></div>
      </div>

      ${rot && !rot.abstain ? `
      <h3>Rotation Delta <span class="tiny">decomposed, not one number</span></h3>
      <div class="ws-grid">
        <div class="ws-card"><div class="k">Candidate projection</div><div class="v">${num(rot.decomposition.candidateProjection, 2)}</div></div>
        <div class="ws-card"><div class="k">Displaced (weakest)</div><div class="v">${num(rot.decomposition.displacedProjection, 2)}</div></div>
        <div class="ws-card"><div class="k">Median team-mate</div><div class="v">${num(rot.decomposition.medianTeamMate, 2)}</div></div>
        <div class="ws-card"><div class="k">Lineup adjustment</div><div class="v">n/a</div>
          <p class="tiny">no lineup data</p></div>
      </div>
      <div class="ws-grid">
        <div class="ws-card"><div class="k">Neutral delta (this team)</div><div class="v">${num(rot.neutralRotationDelta, 2)}</div>
          <p class="tiny">vs a median team-mate</p></div>
        <div class="ws-card"><div class="k">League-referenced delta</div><div class="v">${num(rot.leagueReferencedDelta, 2)}</div>
          <p class="tiny">vs a median league rotation slot</p></div>
        <div class="ws-card"><div class="k">Best case</div><div class="v">${num(rot.rotationDelta, 2)}</div>
          <p class="tiny">vs the weakest team-mate</p></div>
        <div class="ws-card ${verdictClass}"><div class="k">Verdict</div><div class="v">${esc(rot.verdict)}</div>
          <p class="tiny">follows the neutral delta</p></div>
      </div>
      <p class="tiny">${esc(rot.magnitudeCaveat)}</p>
      <p class="tiny">${esc(rot.leagueNote)}</p>
      <p class="tiny">Minutes reallocated: ${num(rot.minutesReallocated)} from ${rot.displaced.map((x) => `${esc(x.name)} (-${x.minutesTaken})`).join(', ')}</p>
      ` : `<p class="tiny">No rotation delta: ${esc(rot?.reason || 'not computed')}</p>`}

      ${frontierBlock(t, target)}

      <div class="ws-cols">
        <section><h3>Why the model likes it</h3>
          ${(card.strengths || []).map((x) => `<p class="tiny">+ ${esc(x.text)}</p>`).join('') || '<p class="tiny">—</p>'}</section>
        <section><h3>Why it is sceptical</h3>
          ${(card.risks || []).map((x) => `<p class="tiny">- ${esc(x.text)}</p>`).join('') || '<p class="tiny">—</p>'}</section>
      </div>

      ${(() => {
        const src = (!card.abstain && card.projection && Math.abs(card.targetMpg - target) < 0.01)
          ? card.projection : null;
        return src && src.topComparables ? `<h3>Closest comparables at ${target} MPG</h3>
      <div class="table-wrap"><table class="compare-table"><thead><tr>
        <th class="left">Player</th><th>Similarity</th><th>MPG</th><th>On-court diff</th></tr></thead><tbody>
        ${src.topComparables.map((c) => `<tr><td class="left">${esc(c.name)} <span class="tiny">${esc(c.team)}</span></td>
          <td>${num(c.similarity, 1)}</td><td>${num(c.mpg)}</td><td>${num(c.netRtg, 1)}</td></tr>`).join('')}
      </tbody></table></div>`
          : '<p class="tiny">Named comparables are shown for the default scenario; other role bands report their comparable COUNT and mean similarity above.</p>';
      })()}

      ${comparablesNote()}

      <h3>Best supported expansions, this league</h3>
      <div class="table-wrap"><table class="compare-table"><thead><tr>
        <th class="left">Player</th><th>MPG</th><th>Target</th><th>League delta</th><th>Neutral delta</th><th>Support</th><th>Verdict</th></tr></thead><tbody>
        ${cands.filter((x) => !x.tulip.card.abstain && x.tulip.card.rotation && !x.tulip.card.rotation.abstain)
          .slice(0, 25).map((x) => `<tr>
          <td class="left"><button class="player-link" data-tulip="${esc(x.playerId)}">${esc(x.name)}</button>
            <span class="tiny">${esc(x.team)}</span></td>
          <td>${num(x.mpg)}</td><td>${num(x.tulip.card.targetMpg)}</td>
          <td><b>${num(x.tulip.card.rotation.leagueReferencedDelta, 2)}</b></td>
          <td>${num(x.tulip.card.rotation.neutralRotationDelta, 2)}</td>
          <td>${x.tulip.card.projection.support}</td>
          <td class="tiny">${esc(x.tulip.card.rotation.verdict)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function comparablesNote() {
    return `<p class="tiny"><b>What this is.</b> TULIP Evidence v0.1 — a comparable-based
      role-expansion estimator built on ONE season of season-aggregate and starter/bench split
      data. It is observational, not causal: comparables who already occupy a big role are a
      selected group, and that selection is not corrected for. On-court differential is a team
      result while a player is on the floor, shrunk toward the team mean but still unreliable in
      magnitude — read the sign and the ordering, not the number. There is no TULIP Forecast:
      age, multi-season trajectory and aging priors need historical data this database does not
      have.</p>`;
  }

  /** Frontier: projected impact against target role, with support and abstention drawn apart. */
  function frontierBlock(t, target) {
    return `<h3>TULIP Frontier</h3>
      <p class="tiny">Blue band = 80% interval. Bar height = support. Hollow markers = the model
      has <b>no evidence</b> at that role, which is different from expecting decline.</p>
      <canvas id="tuCanvas" width="1000" height="380" style="width:100%;max-width:1000px"
        data-target="${target}"></canvas>
      <div id="tuLegend" class="tiny"></div>`;
  }

  function drawFrontier() {
    const cv = $('tuCanvas'); if (!cv) return;
    const p = byId(state.tulipPlayer); if (!p || !p.tulip) return;
    const pts = p.tulip.frontier;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, pad = 56;
    ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.body);
    const line = (css.getPropertyValue('--line') || '#273142').trim();
    const muted = (css.getPropertyValue('--muted') || '#9aabba').trim();

    const supported = pts.filter((f) => !f.abstain && fin(f.projectedImpact));
    const xs = pts.map((f) => f.mpg);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const lows = supported.flatMap((f) => (f.interval ? [f.interval[0]] : [f.projectedImpact]));
    const highs = supported.flatMap((f) => (f.interval ? [f.interval[1]] : [f.projectedImpact]));
    const ymin = supported.length ? Math.min(...lows) - 1 : -5;
    const ymax = supported.length ? Math.max(...highs) + 1 : 5;
    const PX = (v) => pad + ((v - xmin) / (xmax - xmin || 1)) * (W - pad * 2);
    const PY = (v) => H - pad - ((v - ymin) / (ymax - ymin || 1)) * (H - pad * 2);

    // support bars along the bottom
    ctx.fillStyle = 'rgba(99,179,255,.16)';
    for (const f of pts) {
      const h = ((f.support || 0) / 100) * (H - pad * 2) * 0.28;
      ctx.fillRect(PX(f.mpg) - 16, H - pad - h, 32, h);
    }
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, W - pad * 2, H - pad * 2);
    ctx.fillStyle = muted; ctx.font = '12px system-ui';
    for (const f of pts) ctx.fillText(String(f.mpg), PX(f.mpg) - 8, H - pad + 18);
    for (let i = 0; i <= 4; i++) {
      const gy = ymin + ((ymax - ymin) * i) / 4;
      ctx.fillText(gy.toFixed(1), 8, PY(gy) + 4);
    }
    // zero line
    if (ymin < 0 && ymax > 0) {
      ctx.strokeStyle = 'rgba(154,171,186,.45)'; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad, PY(0)); ctx.lineTo(W - pad, PY(0)); ctx.stroke();
      ctx.setLineDash([]);
    }
    // uncertainty band across supported bands
    if (supported.length > 1) {
      ctx.fillStyle = 'rgba(99,179,255,.20)';
      ctx.beginPath();
      supported.forEach((f, i) => { const y = f.interval ? f.interval[1] : f.projectedImpact;
        i ? ctx.lineTo(PX(f.mpg), PY(y)) : ctx.moveTo(PX(f.mpg), PY(y)); });
      for (let i = supported.length - 1; i >= 0; i--) {
        const f = supported[i]; const y = f.interval ? f.interval[0] : f.projectedImpact;
        ctx.lineTo(PX(f.mpg), PY(y));
      }
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#63b3ff'; ctx.lineWidth = 2; ctx.beginPath();
      supported.forEach((f, i) => (i ? ctx.lineTo(PX(f.mpg), PY(f.projectedImpact))
                                    : ctx.moveTo(PX(f.mpg), PY(f.projectedImpact))));
      ctx.stroke();
    }
    // markers: filled = supported estimate, hollow = INSUFFICIENT EVIDENCE
    for (const f of pts) {
      const x = PX(f.mpg);
      if (f.abstain || !fin(f.projectedImpact)) {
        ctx.strokeStyle = muted; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, PY((ymin + ymax) / 2), 6, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = muted; ctx.fillText('no ev.', x - 16, PY((ymin + ymax) / 2) - 12);
      } else {
        ctx.fillStyle = '#63b3ff';
        ctx.beginPath(); ctx.arc(x, PY(f.projectedImpact), 5, 0, Math.PI * 2); ctx.fill();
      }
    }
    // current role marker
    if (fin(p.mpg) && p.mpg >= xmin && p.mpg <= xmax) {
      ctx.strokeStyle = '#9be38f'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(PX(p.mpg), pad); ctx.lineTo(PX(p.mpg), H - pad); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#9be38f'; ctx.fillText('current ' + p.mpg.toFixed(1), PX(p.mpg) + 6, pad + 14);
    }
    // chosen target marker
    const tgt = Number(cv.dataset.target);
    if (fin(tgt) && tgt >= xmin && tgt <= xmax) {
      ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(PX(tgt), pad); ctx.lineTo(PX(tgt), H - pad); ctx.stroke();
      ctx.fillStyle = '#ffd166'; ctx.fillText('target ' + tgt, PX(tgt) + 6, pad + 30);
    }
    $('tuLegend').innerHTML = `X = target role (MPG) · Y = projected on-court impact ·
      faint bars = TULIP Support at that role ·
      <span style="color:#9be38f">green</span> = current role ·
      <span style="color:#ffd166">amber</span> = selected target ·
      hollow marker = <b>insufficient evidence</b> (not a predicted decline)`;
  }

  /* ------------------------------------------------------------- wiring */
  function wire() {
    const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };
    on('wsPlayerSel', 'change', (e) => { state.player = e.target.value; render(); });
    on('wsFindSimilar', 'click', () => { state.simPlayer = state.player; MODE = 'similarity'; render(); });
    on('simSel', 'change', (e) => { state.simPlayer = e.target.value; render(); });
    on('simLeague', 'change', (e) => { state.simLeague = e.target.value; render(); });
    on('simMin', 'change', (e) => { state.simMinMin = Number(e.target.value) || 0; render(); });
    on('tfTeam', 'change', (e) => { state.team = e.target.value; render(); });
    on('tuPlayer', 'change', (e) => { state.tulipPlayer = e.target.value; state.tulipTarget = null; render(); });
    on('tuTarget', 'change', (e) => { state.tulipTarget = Number(e.target.value); render(); });
    document.querySelectorAll('[data-tulip]').forEach((b) => {
      b.onclick = () => { state.tulipPlayer = b.dataset.tulip; state.tulipTarget = null; render(); };
    });
    for (const [id, key] of [['scX', 'scatterX'], ['scY', 'scatterY'], ['scSize', 'scatterSize'], ['scColor', 'scatterColor']]) {
      on(id, 'change', (e) => { state[key] = e.target.value; render(); });
    }
    document.querySelectorAll('[data-preset]').forEach((b) => {
      b.onclick = () => { const [x, y] = b.dataset.preset.split('|'); state.scatterX = x; state.scatterY = y; render(); };
    });
    document.querySelectorAll('[data-goto]').forEach((b) => {
      b.onclick = () => { state.player = b.dataset.goto; MODE = 'player'; render(); };
    });
  }

  window.__wsOpenPlayer = (id) => { state.player = id; MODE = 'player'; render(); };
  window.__wsInit = () => { render(); };
  window.__wsMode = () => MODE;

  /**
   * Self-initialise. app.js also calls __wsInit, but in the standalone build its init() runs
   * synchronously (the data is inlined, so there is no fetch to await) and therefore fires
   * before this file has even been parsed. Waiting for the data ourselves covers both builds.
   */
  (function boot(tries = 0) {
    if (window.DATA && window.__wsLeague && document.getElementById('modeNav')) { render(); return; }
    if (tries > 400) return;
    setTimeout(() => boot(tries + 1), 25);
  })();
})();
