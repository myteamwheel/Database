/* Analysis workspace: modes beyond the table. Loaded after app.js and reuses its helpers.
   Database | Player | Compare | Scatter | Player Comps | Team Fit are real tools, not presets. */
(() => {
  const $ = (id) => document.getElementById(id);
  const fin = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 1) => (fin(v) ? Number(v).toFixed(d) : '—');
  /** Grades are capped at 9.9999; rounding to 2dp would print 10.00, which the scale cannot reach. */
  const gnum = (v, d = 2) => (fin(v) ? (Math.floor(Number(v) * 10 ** d) / 10 ** d).toFixed(d) : '—');
  const pctS = (v) => (fin(v) ? `${(Number(v) * 100).toFixed(1)}%` : '—');
  const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  let MODE = 'database';
  let HISTORY_GAMES = null;
  let HISTORY_GAMES_PROMISE = null;
  const state = { player: null, scatterX: 'usg', scatterY: 'ts', scatterSize: '', scatterColor: 'positionFamily',
                  simPlayer: null, simTeam: '', simPosition: '', simQuery: '', simActiveIndex: -1, simSuggestionsOpen: false, simCompScope: 'same', team: null,
                  tulipPlayer: null, tulipTarget: null };

  const league = () => window.__wsLeague();
  // Charts and rankings need a played season, while the Player and Player Comps pickers also
  // need current-roster rookies and signings who have no 2025-26 NBA line yet.
  const players = () => (window.DATA?.leagues?.[league()] || []).filter((p) => p.appeared);
  const pickerPlayers = () => league() === 'NBA'
    ? (window.DATA?.leagues?.NBA || []).filter((p) => p.appeared || p.currentRoster)
    : players();
  const byId = (id) => pickerPlayers().find((p) => String(p.playerId) === String(id));
  const compTargets = () => window.DATA?.analysis?.playerCompTargets || [];
  const compPickerPlayers = () => {
    const targets = compTargets();
    const targetNames = new Set(targets.map((p) => fold(p.name)));
    return [...targets, ...pickerPlayers().filter((p) => !targetNames.has(fold(p.name)))];
  };
  const compById = (id) => compPickerPlayers().find((p) => String(p.playerId) === String(id));

  /* ------------------------------------------------------------- mode nav */
  const MODES = [
    ['database', 'Database'], ['player', 'Player'], ['compare', 'Compare'],
    ['scatter', 'Scatter'], ['similarity', 'Player Comps'], ['teamfit', 'Team Fit'],
    ['tulip', 'Role Value'],
  ];

  const changeMode = (mode, push = true) => {
    MODE = MODES.some(([key]) => key === mode) ? mode : 'database';
    render();
    if (push) window.__siteUrlChanged?.('push');
  };

  function renderNav() {
    $('modeNav').innerHTML = MODES.map(([k, label]) =>
      `<button class="mode-tab${MODE === k ? ' active' : ''}" data-mode="${k}">${esc(label)}</button>`).join('');
    document.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = () => changeMode(b.dataset.mode);
    });
  }

  function render() {
    renderNav();
    const isComp = MODE === 'similarity';
    const isDb = MODE === 'database';
    const lg = league() === 'NBA' ? 'NBA' : 'G League';
    document.querySelectorAll('.site-link[data-goto]').forEach((b) => {
      if (isComp) b.classList.toggle('active', b.dataset.goto === 'comps');
      else if (MODE !== 'database') b.classList.toggle('active', b.dataset.goto === 'stats');
    });
    if (isComp) {
      if ($('pageTitle')) $('pageTitle').textContent = `${lg} Player Comparisons`;
      if ($('crumbs')) $('crumbs').textContent = `${lg} › Historical player comparisons`;
      if ($('seasonEyebrow')) $('seasonEyebrow').textContent = 'Historical similarity engine';
    } else if (!isDb) {
      // Returning from Player Comps previously left its title, crumbs and eyebrow behind on every
      // other analysis tab. Keep the persistent page chrome synchronized with the active tool.
      const labels = Object.fromEntries(MODES);
      const title = MODE === 'player' ? 'Player Analysis'
        : MODE === 'compare' ? 'Player Comparison'
        : MODE === 'scatter' ? 'Scatter & Correlation'
        : MODE === 'teamfit' ? 'Team Fit'
        : MODE === 'tulip' ? 'Role Value' : (labels[MODE] || 'Analysis');
      if ($('pageTitle')) $('pageTitle').textContent = `${lg} ${title}`;
      const period = MODE === 'compare' && $('viewPreset')?.value === 'proj' ? '2026-27 projections' : '2025-26';
      if ($('crumbs')) $('crumbs').textContent = `${lg} › ${period} › ${title}`;
      if ($('seasonEyebrow')) $('seasonEyebrow').textContent = '2025-26 analysis workspace';
    }
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
  // An old season team is history, not a current roster claim. Never fall back to it here.
  const teamOf = (p) => p?.compTarget ? (p.currentTeam || p.team || 'Brooklyn / Long Island')
    : p?.league === 'NBA' ? (p.currentTeam || 'No NBA roster') : (p?.team || '—');
  const teamContext = (p) => p?.compTarget
    ? `Comparison target: ${p.currentTeam || p.team || 'Brooklyn / Long Island'}`
    : p?.league === 'NBA'
      ? (p.currentTeam ? `Current NBA roster: ${p.currentTeam}` : 'No current NBA roster')
      : `${window.DATA?.season || '2025-26'} G League team: ${p?.team || '—'}`;
  const rosterLabel = (p) => p?.compTarget
    ? `${teamOf(p)} · ${p.sourceMode === 'gleague' ? 'G League-sourced NBA comp' : 'pre-NBA-sourced NBA comp'}`
    : p?.currentRoster && !p.appeared
      ? `${teamOf(p)} · current roster, no 2025-26 NBA stats`
      : teamOf(p);

  const bar = (label, v, extra = '') =>
    `<div class="pbar"><span class="pbar-l">${esc(label)}</span>
      <span class="pbar-t"><i style="width:${fin(v) ? Math.max(1, Math.min(100, v)) : 0}%"></i></span>
      <b>${fin(v) ? Number(v).toFixed(0) : '—'}</b>${extra}</div>`;
  const disclosure = (label, body) => `<details class="ws-disclosure"><summary>${label}</summary><div class="ws-disclosure-body">${body}</div></details>`;
  const transactionHistory = (p) => !p.recentNbaTransactions?.length ? '' : disclosure('Recent official NBA transactions',
    `<p class="tiny">Source ledger through ${esc(window.DATA.transactionMeta?.latestEventDate)}; fetched ${esc(window.DATA.transactionMeta?.fetchedAt?.slice(0,10))}. These events do not establish medical clearance or G League assignment status.</p><ul>${p.recentNbaTransactions.map(event => `<li><b>${esc(event.date)} · ${esc(event.type)}</b>: ${esc(event.description)}</li>`).join('')}</ul><p class="tiny">Up to three events since ${esc(window.DATA.transactionMeta?.fromDate)}. Current roster status comes from the separate official roster snapshot; these notes do not silently change statistical forecasts.</p>`);

  const playerPicker = (id, selected, label) =>
    `<label>${esc(label)}<select id="${id}">${
      pickerPlayers().slice().sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => `<option value="${esc(p.playerId)}"${p.playerId === selected ? ' selected' : ''}>${esc(p.name)} — ${esc(rosterLabel(p))}</option>`).join('')
    }</select></label>`;

  const compPlayerLabel = (p) => `${p.name} — ${teamOf(p)}`;
  const compPool = () => compPickerPlayers().filter((p) =>
    (!state.simTeam || teamOf(p) === state.simTeam)
    && (!state.simPosition || p.position === state.simPosition || p.positionFamily === state.simPosition));
  const compPlayerSearch = (p) => {
    const teams = [...new Set(compPickerPlayers().map(teamOf).filter(Boolean))].sort();
    const positions = [...new Set(compPickerPlayers().map((x) => x.position).filter(Boolean))].sort();
    if (state.simTeam && !teams.includes(state.simTeam)) state.simTeam = '';
    if (state.simPosition && !positions.includes(state.simPosition)) state.simPosition = '';
    return `<section class="comp-search-panel" aria-label="Player comparison search">
      <label class="comp-search-main">Search player
        <input id="simSearch" type="search" autocomplete="off" spellcheck="false"
          value="${esc(p?.name || '')}" placeholder="Start typing a player name…"
          aria-label="Search player for historical comparisons" aria-controls="simSuggestions"
          aria-expanded="${state.simSuggestionsOpen ? 'true' : 'false'}" aria-autocomplete="list" role="combobox" />
      </label>
      <label>Team<select id="simTeam"><option value="">All teams</option>
        ${teams.map((t) => `<option value="${esc(t)}"${t === state.simTeam ? ' selected' : ''}>${esc(t)}</option>`).join('')}
      </select></label>
      <label>Position<select id="simPosition"><option value="">All positions</option>
        ${positions.map((pos) => `<option value="${esc(pos)}"${pos === state.simPosition ? ' selected' : ''}>${esc(pos)}</option>`).join('')}
      </select></label>
      <div id="simSuggestions" class="comp-suggestions" role="listbox" hidden></div>
    </section>`;
  };

  function compSuggestionMatches(raw = '') {
    const q = fold(raw).trim();
    let list = compPool();
    if (q) list = list.filter((p) => fold(`${p.name} ${teamOf(p)} ${p.position || ''}`).includes(q));
    return list.sort((a, b) => {
      const ap = q && fold(a.name).startsWith(q) ? 0 : 1;
      const bp = q && fold(b.name).startsWith(q) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    });
  }

  function hideCompSuggestions() {
    const box = $('simSuggestions'), input = $('simSearch');
    state.simSuggestionsOpen = false;
    state.simActiveIndex = -1;
    if (box) box.hidden = true;
    if (input) {
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
  }

  function updateCompSuggestions(raw = '') {
    const box = $('simSuggestions');
    if (!box) return;
    const q = fold(raw).trim();
    const list = compSuggestionMatches(raw);
    state.simSuggestionsOpen = true;
    state.simActiveIndex = list.length ? Math.max(-1, Math.min(state.simActiveIndex, list.length - 1)) : -1;
    box.hidden = false;
    const input = $('simSearch');
    if (input) {
      input.setAttribute('aria-expanded', 'true');
      if (state.simActiveIndex >= 0) input.setAttribute('aria-activedescendant', `simOption-${list[state.simActiveIndex].playerId}`);
      else input.removeAttribute('aria-activedescendant');
    }
    box.innerHTML = list.length ? `<div class="comp-suggestion-count" aria-live="polite">${list.length.toLocaleString()} ${q ? 'matching' : 'available'} players · scroll to browse${q ? '' : ' or type to narrow'}</div>`
      + list.map((p, i) => `<button id="simOption-${esc(p.playerId)}" class="${i === state.simActiveIndex ? 'is-active' : ''}" type="button" role="option" aria-selected="${i === state.simActiveIndex}" data-sim-pick="${esc(p.playerId)}">
      <b>${esc(p.name)}</b><span>${esc(rosterLabel(p))} · ${esc(p.position || '—')}</span></button>`).join('')
      : `<div class="comp-suggestion-count" role="status">No matching players. Try a different name, team, or position.</div>`;
  }

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

  function decodedHistory(p) {
    const schema = window.DATA?.analysis?.history?.browserSchema || [];
    if (!schema.length || !Array.isArray(p?.history)) return [];
    return p.history.map((row) => Object.fromEntries(schema.map((k, i) => [k, row[i]])));
  }

  async function gunzipJson(bytes) {
    if (typeof DecompressionStream !== 'function') throw new Error('Game logs require a modern browser with DecompressionStream support.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  async function loadHistoryGames() {
    if (HISTORY_GAMES) return HISTORY_GAMES;
    if (HISTORY_GAMES_PROMISE) return HISTORY_GAMES_PROMISE;
    HISTORY_GAMES_PROMISE = (async () => {
      const embedded = document.getElementById('history-db-gz');
      let bytes;
      if (embedded?.textContent?.trim()) {
        const raw = atob(embedded.textContent.trim());
        bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      } else {
        const r = await fetch('./public/history-games.json.gz', { cache: 'no-store' });
        if (!r.ok) throw new Error(`history-games.json.gz returned ${r.status}`);
        bytes = new Uint8Array(await r.arrayBuffer());
      }
      const d = await gunzipJson(bytes);
      if (d?.schemaVersion !== 1 || !Array.isArray(d?.rowSchema) || !d?.byPlayer) throw new Error('Unsupported historical game-log artifact.');
      HISTORY_GAMES = d;
      return d;
    })();
    try { return await HISTORY_GAMES_PROMISE; } finally { if (!HISTORY_GAMES) HISTORY_GAMES_PROMISE = null; }
  }

  function decodeGameRows(product, p) {
    const id = String(p.nbaPersonId ?? p.playerId);
    const rows = product?.byPlayer?.[id] || [];
    const schema = product?.rowSchema || [];
    return rows.map((row) => Object.fromEntries(schema.map((k, i) => [k, row[i]])));
  }

  function historicalCareerSummary(p) {
    const hist = decodedHistory(p);
    const reg = hist.filter((r) => r.seasonType === 'Regular Season');
    const po = hist.filter((r) => r.seasonType === 'Playoffs');
    if (!reg.length) return null;
    const finiteRows = (k) => reg.filter((r) => fin(r[k]));
    const peak = (k) => finiteRows(k).slice().sort((a, b) => Number(b[k]) - Number(a[k]))[0] || null;
    const latest = reg.slice().sort((a, b) => String(b.season).localeCompare(String(a.season)))[0];
    return {
      seasons: new Set(reg.map((r) => r.season)).size,
      games: reg.reduce((a, r) => a + (Number(r.gp) || 0), 0),
      teams: new Set(reg.flatMap((r) => r.teams || [])).size,
      playoffSeasons: new Set(po.map((r) => r.season)).size,
      latest,
      peakPts: peak('pts'), peakMpg: peak('mpg'), peakTs: peak('ts'),
    };
  }

  /* ---------------------------------------------------------- PLAYER MODE */
  function playerProjection(p) {
    if (!p.proj || !window.__wsProjCard) return '';
    const headline=p.proj.abstain ? 'No estimate' : `${num(p.proj.pts)} PTS · ${num(p.proj.reb)} REB · ${num(p.proj.ast)} AST per game`;
    return `<details class="ws-disclosure ws-projection"><summary>2026-27 projection <span class="tiny">${esc(headline)}</span></summary><div class="ws-disclosure-body">${window.__wsProjCard(p)}</div></details>`;
  }

  function viewPlayer() {
    const p = byId(state.player) || players()[0];
    if (!p) return '<p class="loading">No players.</p>';
    state.player = p.playerId;
    if (!p.appeared) return viewCurrentRosterOnlyPlayer(p);
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
        <p class="tiny">${esc(p.leagueLabel)} · ${esc(teamContext(p))} · ${esc(p.position || '—')} · ${p.ageOpeningNight ?? p.age ?? '—'} yrs · ${esc(p.height || '—')}</p>
        <p class="tiny">${esc(window.DATA?.season || '2025-26')} actuals: ${p.gp} games · ${num(p.mpg)} mpg</p></div>
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
      ${cr.team ? `<div class="ws-card"><div class="k">2025-26 ${esc(p.seasonTeam || p.team)}</div><div class="v">#${cr.team.rank}</div><p class="tiny">of ${cr.team.of}</p></div>` : ''}
    </div>

    ${playerProjection(p)}

    ${transactionHistory(p)}

    ${disclosure('Grade components and full skill profile', `<div class="ws-cols">
      <section><h3>Grade components</h3>
        ${Object.entries(p.components || {}).map(([k, v]) =>
          bar(k, v, ` <span class="tiny">${esc(p.gradeCoverageDetail?.[k] || '')}</span>`)).join('')}
      </section>
      <section><h3>Skill profile <span class="tiny">percentile within ${esc(p.leagueLabel)}</span></h3>
        ${Object.entries(sp).map(([k, v]) => bar(k, v)).join('')}
      </section>
    </div>`)}

    <div class="ws-cols">
      <section><h3>Strengths</h3>${strengths.slice(0, 5).map(([k, v]) => bar(k, v)).join('') || '<p class="tiny">—</p>'}</section>
      <section><h3>Weaknesses</h3>${strengths.slice(-5).reverse().map(([k, v]) => bar(k, v)).join('') || '<p class="tiny">—</p>'}</section>
    </div>

    <h3>Archetypes <span class="tiny">rule-based, with the axes that drove each score</span></h3>
    <div class="arche-row">${arche || '<p class="tiny">Not enough profile data.</p>'}</div>

    ${p.ownTeamFit ? `<h3>Fit with ${esc(teamOf(p))}</h3>
      <div class="ws-card wide"><div class="v">${p.ownTeamFit.score}/100</div>
        <p class="tiny">${[...p.ownTeamFit.strengths, ...p.ownTeamFit.weaknesses].map(esc).join('<br>')}</p>
        <p class="tiny">Fit is not quality — it measures how well this profile answers what the roster lacks.</p></div>` : ''}

    ${disclosure('Situational splits', `<div class="table-wrap"><table class="compare-table"><thead><tr><th class="left">Split</th>
      <th>G</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>TS%</th><th>USG%</th><th>PIE</th><th>NetRtg</th></tr></thead><tbody>
      ${splits.filter((s) => fin(sv(s, 'gp'))).map((s) => `<tr><td class="left">${esc(s)}</td>
        <td>${num(sv(s, 'gp'), 0)}</td><td>${num(sv(s, 'mpg'))}</td><td>${num(sv(s, 'pts'))}</td>
        <td>${num(sv(s, 'reb'))}</td><td>${num(sv(s, 'ast'))}</td><td>${pctS(sv(s, 'ts'))}</td>
        <td>${pctS(sv(s, 'usg_pct'))}</td><td>${pctS(sv(s, 'pie'))}</td><td>${num(sv(s, 'net_rating'))}</td></tr>`).join('')}
    </tbody></table></div>`)}

    ${months.length ? disclosure('Month by month · season-relative', `${sparkline(months.map((m) => sv(`month${m}`, 'pts')), months.map((m) => 'M' + m))}
      <div class="table-wrap"><table class="compare-table"><thead><tr><th class="left">Month</th>
        <th>G</th><th>PTS</th><th>TS%</th><th>USG%</th><th>PIE</th></tr></thead><tbody>
        ${months.map((m) => `<tr><td class="left">M${m}</td><td>${num(sv(`month${m}`, 'gp'), 0)}</td>
          <td>${num(sv(`month${m}`, 'pts'))}</td><td>${pctS(sv(`month${m}`, 'ts'))}</td>
          <td>${pctS(sv(`month${m}`, 'usg_pct'))}</td><td>${pctS(sv(`month${m}`, 'pie'))}</td></tr>`).join('')}
      </tbody></table></div>`) : ''}

    ${historyBlock(p)}
    ${historyGameLogShell(p)}

    ${(p.teams || []).length > 1 ? disclosure('2025–26 team history', `<div class="table-wrap"><table class="compare-table">
      <thead><tr><th class="left">Team</th><th>G</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>FG%</th><th>+/-</th></tr></thead>
      <tbody>${p.teams.map((s) => `<tr><td class="left">${esc(s.team)}</td><td>${s.gp}</td><td>${num(s.mpg)}</td>
        <td>${num(s.pts)}</td><td>${num(s.reb)}</td><td>${num(s.ast)}</td><td>${pctS(s.fgPct)}</td><td>${num(s.plusMinus)}</td></tr>`).join('')}
      </tbody></table></div>`) : ''}

    ${p.nbaTranslation && Object.keys(p.nbaTranslation).length ? translationBlock(p) : ''}
    <div class="ws-actions"><button class="button" id="wsFindSimilar">Find player comps</button></div>`;
  }

  /** A roster listing is useful, but it must never masquerade as a performance profile. */
  function viewCurrentRosterOnlyPlayer(p) {
    return `
      <div class="ws-head">
        <div>${playerPicker('wsPlayerSel', p.playerId, 'Player')}</div>
        <div class="ws-title"><h2>${esc(p.name)}</h2>
          <p class="tiny">NBA · ${esc(rosterLabel(p))} · ${esc(p.position || '—')} · ${esc(p.height || '—')} · ${p.weight ? `${p.weight} lb` : '—'}</p></div>
      </div>
      <section class="ws-card wide">
        <div class="eyebrow">CURRENT NBA ROSTER PROFILE</div>
        <h3>Listed on ${esc(teamOf(p))}; no 2025-26 NBA appearance</h3>
        <p class="tiny">This player is included because the current official NBA roster snapshot lists him. He is intentionally not given a 2025-26 performance grade, rank, or historical player comp without a usable 2025-26 NBA sample.</p>
      </section>
      <div class="ws-grid">
        <div class="ws-card"><div class="k">Current roster</div><div class="v">${esc(teamOf(p))}</div><p class="tiny">published current roster snapshot</p></div>
        <div class="ws-card"><div class="k">2025-26 NBA line</div><div class="v">—</div><p class="tiny">no NBA appearance; not missing a stat row</p></div>
        <div class="ws-card"><div class="k">Historical player comps</div><div class="v">N/A</div><p class="tiny">requires a usable 2025-26 NBA sample</p></div>
      </div>
      ${playerProjection(p)}
      ${transactionHistory(p)}`;
  }

  function historyBlock(p) {
    const hist = decodedHistory(p);
    if (!hist.length) return '';
    const reg = hist.filter((r) => r.seasonType === 'Regular Season')
      .sort((a, b) => String(a.season).localeCompare(String(b.season)));
    const summary = historicalCareerSummary(p);
    const tableRows = hist.slice().sort((a, b) => String(b.season).localeCompare(String(a.season))
      || (a.seasonType === 'Regular Season' ? -1 : 1));
    const seasons = reg.map((r) => r.season);
    const starter = (r) => r.starts == null ? '—' : String(r.starts);
    const teamText = (r) => (r.teams || []).join('/') || '—';
    const phase = (r) => r.seasonType === 'Playoffs' ? 'PO' : 'RS';
    const peakText = (row, key, suffix = '') => row && fin(row[key]) ? `${num(row[key])}${suffix} · ${esc(row.season)}` : '—';
    return `<details class="ws-disclosure"><summary>Historical NBA record <span class="tiny">2015-16 through 2024-25 · descriptive, not a forecast</span></summary><div class="ws-disclosure-body">
      ${summary ? `<div class="ws-grid">
        <div class="ws-card"><div class="k">Historical seasons</div><div class="v">${summary.seasons}</div><p class="tiny">${summary.games} RS games · ${summary.teams} team${summary.teams === 1 ? '' : 's'}</p></div>
        <div class="ws-card"><div class="k">Peak scoring</div><div class="v">${peakText(summary.peakPts, 'pts')}</div><p class="tiny">regular-season PPG</p></div>
        <div class="ws-card"><div class="k">Peak workload</div><div class="v">${peakText(summary.peakMpg, 'mpg')}</div><p class="tiny">regular-season MPG</p></div>
        <div class="ws-card"><div class="k">Playoff history</div><div class="v">${summary.playoffSeasons}</div><p class="tiny">seasons with a playoff appearance</p></div>
      </div>` : ''}
      ${reg.length > 1 ? `<p class="tiny"><b>Regular-season scoring trajectory</b></p>${sparkline(reg.map((r) => r.pts), seasons)}` : ''}
      <div class="table-wrap"><table class="compare-table"><thead><tr>
        <th class="left">Season</th><th>Phase</th><th>Team(s)</th><th>G</th><th>MPG</th><th>PTS</th><th>REB</th><th>AST</th><th>TS%</th><th>Starts</th><th>Start share</th><th>Starter coverage</th>
      </tr></thead><tbody>${tableRows.map((r) => `<tr><td class="left">${esc(r.season)}</td><td>${phase(r)}</td><td>${esc(teamText(r))}</td>
        <td>${num(r.gp,0)}</td><td>${num(r.mpg)}</td><td>${num(r.pts)}</td><td>${num(r.reb)}</td><td>${num(r.ast)}</td><td>${r.ts == null ? '—' : pctS(r.ts)}</td>
        <td>${starter(r)}</td><td>${r.startShareOfAppearances == null ? '—' : pctS(r.startShareOfAppearances)}</td><td>${r.starterCoverage == null ? '—' : pctS(r.starterCoverage)}</td></tr>`).join('')}</tbody></table></div>
      <p class="tiny">Latest seasons are shown first in the table; the trajectory runs chronologically. RS and PO are separate source phases. Starter columns remain unknown where the canonical starter artifact has not established them; coverage shows the share of appearances with known starter status, and unknown is never treated as bench.</p></div></details>`;
  }

  function historyCompareBlock(ps) {
    const rowsByPlayer = ps.map((p) => ({ p, rows: decodedHistory(p).filter((r) => r.seasonType === 'Regular Season') }));
    if (rowsByPlayer.filter((x) => x.rows.length).length < 2) return '';
    const seasons = [...new Set(rowsByPlayer.flatMap((x) => x.rows.map((r) => r.season)))].sort().reverse();
    const bySeason = rowsByPlayer.map(({ rows }) => new Map(rows.map((r) => [r.season, r])));
    const summaries = ps.map(historicalCareerSummary);
    const peak = (s, key) => s?.[key] && fin(s[key][key === 'peakPts' ? 'pts' : key === 'peakMpg' ? 'mpg' : 'ts'])
      ? `${num(s[key][key === 'peakPts' ? 'pts' : key === 'peakMpg' ? 'mpg' : 'ts'])} (${esc(s[key].season)})` : '—';
    return `<h3>Historical comparison <span class="tiny">regular season · descriptive</span></h3>
      <div class="table-wrap"><table class="compare-table"><thead><tr><th class="left">Historical measure</th>
        ${ps.map((p) => `<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>
        <tr><td class="left">Seasons in window</td>${summaries.map((x) => `<td>${x?.seasons ?? '—'}</td>`).join('')}</tr>
        <tr><td class="left">RS games</td>${summaries.map((x) => `<td>${x?.games ?? '—'}</td>`).join('')}</tr>
        <tr><td class="left">Peak PPG</td>${summaries.map((x) => `<td>${peak(x, 'peakPts')}</td>`).join('')}</tr>
        <tr><td class="left">Peak MPG</td>${summaries.map((x) => `<td>${peak(x, 'peakMpg')}</td>`).join('')}</tr>
        <tr><td class="left">Playoff seasons</td>${summaries.map((x) => `<td>${x?.playoffSeasons ?? '—'}</td>`).join('')}</tr>
      </tbody></table></div>
      <p class="tiny"><b>Season trajectory:</b> each cell is PTS / MPG. Blank means no NBA regular-season appearance in that season.</p>
      <div class="table-wrap"><table class="compare-table"><thead><tr><th class="left">Season</th>${ps.map((p) => `<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>
        ${seasons.map((season) => `<tr><td class="left">${esc(season)}</td>${bySeason.map((m) => { const r = m.get(season); return `<td>${r ? `${num(r.pts)} / ${num(r.mpg)}` : '—'}</td>`; }).join('')}</tr>`).join('')}
      </tbody></table></div>
      <p class="tiny">No era adjustment or causal interpretation is applied. Starter status is intentionally omitted here because historical starter coverage is incomplete outside accepted source phases.</p>`;
  }

  function historyGameLogShell(p) {
    if (!decodedHistory(p).length) return '';
    return `<details class="ws-disclosure"><summary>Historical game log <span class="tiny">loaded on demand</span></summary><div class="ws-disclosure-body">
      <div id="historyGameLog" class="ws-card wide">
        <p class="tiny">Game-level NBA history is kept in a separate compressed artifact so the main database does not pay the network/memory cost until you ask for it. Starter status remains unknown outside accepted source phases.</p>
        <button class="button secondary" id="wsLoadHistoryGames" data-history-player="${esc(p.playerId)}">Load game log</button>
      </div></div></details>`;
  }

  function renderHistoryGames(p, product, seasonFilter = 'all', limit = 50) {
    const target = $('historyGameLog');
    if (!target) return;
    const all = decodeGameRows(product, p).slice().sort((a, b) => String(b.gameDate).localeCompare(String(a.gameDate)) || String(b.gameId).localeCompare(String(a.gameId)));
    const seasons = [...new Set(all.map((r) => r.season))].sort().reverse();
    const filtered = seasonFilter === 'all' ? all : all.filter((r) => r.season === seasonFilter);
    const shown = filtered.slice(0, limit === 0 ? filtered.length : limit);
    const started = (r) => r.started === true ? 'Yes' : r.started === false ? 'No' : '—';
    target.innerHTML = `<div class="ws-controls">
      <label>Season<select id="histGameSeason"><option value="all">All seasons</option>${seasons.map((x) => `<option value="${esc(x)}"${x === seasonFilter ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <label>Rows<select id="histGameLimit">${[25,50,100,0].map((n) => `<option value="${n}"${n === limit ? ' selected' : ''}>${n || 'All'}</option>`).join('')}</select></label>
      <span class="tiny">${shown.length.toLocaleString()} of ${filtered.length.toLocaleString()} games · ${all.length.toLocaleString()} loaded</span>
    </div>
    <div class="table-wrap"><table class="compare-table"><thead><tr>
      <th class="left">Date</th><th>Season</th><th>Phase</th><th>Team</th><th>Opp</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TOV</th><th>+/-</th><th>Starter</th>
    </tr></thead><tbody>${shown.map((r) => `<tr><td class="left">${esc(r.gameDate)}</td><td>${esc(r.season)}</td><td>${r.seasonType === 'Playoffs' ? 'PO' : 'RS'}</td><td>${esc(r.team)}</td><td>${esc(r.opponent)}</td><td>${num(r.minutes)}</td><td>${num(r.pts,0)}</td><td>${num(r.reb,0)}</td><td>${num(r.ast,0)}</td><td>${num(r.stl,0)}</td><td>${num(r.blk,0)}</td><td>${num(r.tov,0)}</td><td>${num(r.plusMinus,0)}</td><td>${started(r)}</td></tr>`).join('')}</tbody></table></div>
    <p class="tiny">Descriptive game logs only. RS and PO are distinct. A blank Starter value means the canonical source has not established that game; it does not mean bench.</p>`;
    onHistoryControls(p, product);
  }

  function onHistoryControls(p, product) {
    const season = $('histGameSeason'), limit = $('histGameLimit');
    const rerender = () => renderHistoryGames(p, product, season?.value || 'all', Number(limit?.value ?? 50));
    if (season) season.onchange = rerender;
    if (limit) limit.onchange = rerender;
  }

  async function openHistoryGames(p) {
    const target = $('historyGameLog');
    if (!target) return;
    target.innerHTML = '<p class="loading">Loading compressed historical game log…</p>';
    try {
      const product = await loadHistoryGames();
      renderHistoryGames(p, product);
    } catch (e) {
      target.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
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
    if (ps.length < 2) return `<section class="empty-state"><div class="eyebrow">PLAYER COMPARISON</div>
      <h2>Choose two to five players</h2><p>Start in Player Stats, tick the comparison box beside each player, then return here. Your selected players stay checked while you browse.</p>
      <div class="ws-actions"><button class="button" type="button" id="wsChooseCompare">Choose players in Player Stats</button></div></section>`;
    const metrics = ['grade', 'rateGrade', 'magnitudeGrade', 'gp', 'mpg', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov',
      'ts', 'efg', 'usg', 'astPct', 'orebPct', 'drebPct', 'offRtg', 'defRtg', 'netRtg', 'pie'];
    const cross = new Set(ps.map((p) => p.league)).size > 1;
    const best = (k) => {
      const vals = ps.map((p) => valueOf(p, k)).filter(fin).map(Number);
      if (!vals.length) return null;
      const lower = ['tov', 'defRtg'].includes(k);
      return lower ? Math.min(...vals) : Math.max(...vals);
    };
    const projectionMode = $('viewPreset')?.value === 'proj';
    if (projectionMode) {
      const keys = ['gp','mpg','pts','reb','ast','stl','blk','tov','fg3m','fgPct','fg3Pct','ftPct','ts'];
      return `<h2>Compare — 2026–27 projections</h2><p class="tiny">Forecasts, not observed results. Ranges and assumptions are available in each player's projection card.</p>
        <div class="table-wrap"><table class="compare-table"><thead><tr><th>Metric</th>${ps.map(p=>`<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>${keys.map(k=>`<tr><th>${esc(window.__wsLabel('proj.'+k))}</th>${ps.map(p=>`<td>${p.proj?.abstain?'—':window.__wsFmt(p.proj?.[k], 'proj.'+k)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    return `<h2>Compare — 2025–26 actuals</h2>
      ${cross ? '<p class="tiny"><b>Cross-league comparison.</b> Each league is graded against its own population, so grades are not on a shared scale.</p>' : ''}
      <div class="table-wrap"><table class="compare-table"><thead><tr><th class="left">Metric</th>
        ${ps.map((p) => `<th>${esc(p.name)}<span class="tiny">${esc(teamContext(p))} · ${esc(p.position || '')}</span></th>`).join('')}</tr></thead>
        <tbody>${metrics.filter((k) => ps.some((p) => fin(valueOf(p, k)))).map((k) => {
          const b = best(k);
          return `<tr><td class="left">${esc(window.__wsLabel(k))}</td>${ps.map((p) => {
            const v = valueOf(p, k);
            const win = fin(v) && b !== null && Number(v) === b;
            return `<td class="${win ? 'winner' : ''}">${window.__wsFormatCell(p, k)}</td>`;
          }).join('')}</tr>`;
        }).join('')}</tbody></table></div>
      <h3>Skill profile</h3>
      ${Object.keys(ps[0].skillProfile || {}).map((axis) => `<div class="cmp-axis"><span class="pbar-l">${esc(axis.replace(/([a-z])([A-Z])/g, '$1 $2'))}</span>
        ${ps.map((p) => fin(p.skillProfile?.[axis])?`<span class="pbar-t" title="${esc(p.name)}"><i style="width:${p.skillProfile[axis]}%"></i></span>`:`<span class="tiny" title="${esc(p.name)}: unavailable">—</span>`).join('')}</div>`).join('')}
      <p class="tiny">Bars are within-league percentiles, in the order the players appear above.</p>
      ${historyCompareBlock(ps)}`;
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
          ${[['positionFamily', 'Position group'], ['team', 'Team'], ['ageBand', 'Age band'], ['primaryArchetype', 'Primary archetype']].map(([k, label]) => `<option value="${k}"${k === state.scatterColor ? ' selected' : ''}>${label}</option>`).join('')}
        </select></label>
      </div>
      <div class="ws-controls">${presets.map(([x, y, l]) => `<button class="button secondary small" data-preset="${x}|${y}">${esc(l)}</button>`).join('')}</div>
      <section class="scatter-scope" aria-label="Active Database filters">
        <div><b>Database filter scope</b> <span class="tiny">The plot uses the same filters as Database.</span></div>
        <div id="scFilterChips" class="scatter-filter-chips"></div>
        <div class="ws-actions"><button type="button" class="button secondary small" id="scEditFilters">Edit filters in Database</button>
          <button type="button" class="button secondary small" id="scClearFilters">Clear all filters</button></div>
      </section>
      <div id="scStats" class="tiny"></div>
      <canvas id="scCanvas" width="1100" height="560" style="width:100%;max-width:1100px" role="img" tabindex="0" aria-describedby="scChartHint"></canvas>
      <p id="scChartHint" class="tiny">Point the cursor at a dot to identify it, select a dot to open that player, or use the accessible data table below.</p>
      <details id="scLegend"><summary>Full colour legend</summary><div id="scLegendItems" class="scatter-legend"></div></details>
      <div id="scHover" class="tiny"></div>
      <div id="scOutliers"></div><details><summary>Accessible chart data</summary><div id="scData" class="table-wrap"></div></details>`;
  }

  function drawScatter() {
    const cv = $('scCanvas'); if (!cv) return;
    const ctx = cv.getContext('2d');
    const list = window.__wsFiltered().filter((p) => p.appeared);
    const pts = list.filter((p) => fin(valueOf(p, state.scatterX)) && fin(valueOf(p, state.scatterY)))
      .map((p) => ({ p, x: Number(valueOf(p, state.scatterX)), y: Number(valueOf(p, state.scatterY)),
        s: state.scatterSize && fin(valueOf(p, state.scatterSize)) ? Number(valueOf(p, state.scatterSize)) : null }));
    cv.setAttribute('aria-label', `Scatter plot of ${window.__wsLabel(state.scatterY)} versus ${window.__wsLabel(state.scatterX)} for ${pts.length} players. Open Accessible chart data for a keyboard-readable table.`);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const activeFilters = window.__siteFilterSummary?.() || [];
    $('scFilterChips').innerHTML = activeFilters.length
      ? activeFilters.map((f) => `<button type="button" class="scatter-filter-chip" data-filter-clear="${esc(f.key)}" aria-label="Remove ${esc(f.label)} filter"><b>${esc(f.label)}:</b> ${esc(f.value)} <span aria-hidden="true">×</span></button>`).join('')
      : '<span class="tiny">No Database filters are active.</span>';
    $('scClearFilters').disabled = activeFilters.length === 0;
    $('scData').innerHTML = `<table><thead><tr><th>Player</th><th>${esc(window.__wsLabel(state.scatterX))}</th><th>${esc(window.__wsLabel(state.scatterY))}</th></tr></thead><tbody>${pts.map(q=>`<tr><td>${esc(q.p.name)}</td><td>${window.__wsFmt(q.x,state.scatterX)}</td><td>${window.__wsFmt(q.y,state.scatterY)}</td></tr>`).join('')}</tbody></table>`;
    if (pts.length < 2) {
      $('scStats').textContent = `n = ${pts.length} · At least two measured players are needed for this chart. ${list.length - pts.length} missing-coordinate rows excluded.`;
      return;
    }

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
    const accent = (css.getPropertyValue('--accent') || '#e8402a').trim();
    ctx.strokeStyle = line; ctx.fillStyle = muted; ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, W - pad * 2, H - pad * 2);
    ctx.font = '12px "Helvetica Neue", Helvetica, Arial, sans-serif';
    for (let i = 0; i <= 4; i++) {
      const gx = xmin + ((xmax - xmin) * i) / 4, gy = ymin + ((ymax - ymin) * i) / 4;
      ctx.fillText(gx.toFixed(gx > 10 ? 0 : 2), PX(gx) - 12, H - pad + 18);
      ctx.fillText(gy.toFixed(gy > 10 ? 0 : 2), 6, PY(gy) + 4);
    }

    const groupOf = (p) => state.scatterColor === 'ageBand'
      ? (() => { const a = p.ageOpeningNight ?? p.age; return a == null ? '—' : a <= 22 ? '≤22' : a <= 26 ? '23-26' : a <= 30 ? '27-30' : '31+'; })()
      : (p[state.scatterColor] ?? '—');
    const groups = [...new Set(pts.map((q) => groupOf(q.p)))];
    const hue = (g) => `hsl(${(groups.indexOf(g) * 67) % 360} 65% 48%)`;
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
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(PX(xmin), PY(a + b * xmin)); ctx.lineTo(PX(xmax), PY(a + b * xmax)); ctx.stroke();

    const countsByGroup = new Map();
    for (const q of pts) countsByGroup.set(groupOf(q.p), (countsByGroup.get(groupOf(q.p)) || 0) + 1);
    $('scLegendItems').innerHTML = groups.map((g) => `<span class="scatter-legend-item"><i style="--swatch:${hue(g)}"></i>${esc(g)} <small>${countsByGroup.get(g)}</small></span>`).join('');
    $('scStats').innerHTML = `<b>r = ${r.toFixed(3)}</b> · n = ${pts.length} · trend y = ${b.toFixed(3)}x + ${a.toFixed(2)}
      · ${list.length - pts.length} missing-coordinate rows excluded
      · ${list.length} appeared players after filters`;

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
      if (hit) { state.player = hit.p.playerId; changeMode('player'); }
    };
  }

  /* ------------------------------------------------------ PLAYER COMPS MODE */
  function physicalLine(x) {
    const bits = [];
    if (x?.height) bits.push(x.height);
    if (fin(x?.weight)) bits.push(num(x.weight, 0) + ' lb');
    if (x?.wingspan) bits.push(x.wingspan + ' wingspan');
    if (x?.standingReach) bits.push(x.standingReach + ' reach');
    return bits.join(' · ') || 'Measurements unavailable';
  }

  function compBlockScore(c, key) {
    const v = c?.blockScores?.[key];
    return fin(v) ? num(v, 1) : '—';
  }

  function compStrength(score) {
    if (!fin(score)) return 'Unknown';
    if (score >= 80) return 'Very strong match';
    if (score >= 65) return 'Strong match';
    if (score >= 50) return 'Moderate match';
    if (score >= 35) return 'Loose match';
    return 'Weak nearest reference';
  }

  function compLogo(q) {
    const id = q?.teamId;
    const team = q?.team || '—';
    const ns = q?.league === 'NBA' ? 'nba' : 'nbagleague';
    const liveHost = location.protocol === 'https:';
    const src = id && liveHost ? `https://cdn.nba.com/logos/${ns}/${id}/primary/L/logo.svg` : '';
    return `<div class="comp-team-logo">${src
      ? `<img src="${esc(src)}" alt="${esc(team)} logo" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.hidden=false"><span hidden>${esc(team)}</span>`
      : `<span>${esc(team)}</span>`
      }</div>`;
  }

  function cval(v, type = '1') {
    if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return '—';
    const x = Number(v);
    if (type === 'pct') return (x * 100).toFixed(1) + '%';
    if (type === '0') return x.toFixed(0);
    return x.toFixed(1);
  }

  function compCompareTable(p, set, q) {
    const t = set.targetStats || {}, tp = set.targetPhysical || {}, ts = set.targetStyle || {};
    const qs = q.style || {};
    const rows = [
      ['PHYSICAL', null, null, 'section'],
      ['Height', tp.height || '—', q.height || '—', 'text'],
      ['Weight', fin(tp.weight) ? cval(tp.weight, '0') + ' lb' : '—', fin(q.weight) ? cval(q.weight, '0') + ' lb' : '—', 'text'],
      ['Wingspan', tp.wingspan || '—', q.wingspan || '—', 'text'],
      ['Standing reach', tp.standingReach || '—', q.standingReach || '—', 'text'],
      ['ROLE / PRODUCTION', null, null, 'section'],
      ['MPG', t.mpg, q.mpg],
      ['Usage', t.usg, q.usg, 'pct'],
      ['PTS / 36', t.pts36, q.pts36],
      ['FGA / 36', t.fga36, q.fga36],
      ['REB / 36', t.reb36, q.reb36],
      ['AST / 36', t.ast36, q.ast36],
      ['AST%', t.astPct, q.astPct, 'pct'],
      ['AST / TO', t.astTo, q.astTo],
      ['AST ratio', t.astRatio, q.astRatio],
      ['TOV / 36', t.tov36, q.tov36],
      ['PF / 36', t.pf36, q.pf36],
      ['SCORING / SHOT PROFILE', null, null, 'section'],
      ['True shooting', t.ts, q.ts, 'pct'],
      ['eFG%', t.efgPct, q.efgPct, 'pct'],
      ['3P%', t.fg3Pct, q.fg3Pct, 'pct'],
      ['3PA share', t.threeRate, q.threeRate, 'pct'],
      ['FTA / 36', t.fta36, q.fta36],
      ['FT rate', t.ftRate, q.ftRate, 'pct'],
      ['Offensive rating', t.offRtg, q.offRtg],
      ['DEFENSE / REBOUNDING', null, null, 'section'],
      ['STL / 36', t.stl36, q.stl36],
      ['BLK / 36', t.blk36, q.blk36],
      ['DREB%', t.drebPct, q.drebPct, 'pct'],
      ['OREB%', t.orebPct, q.orebPct, 'pct'],
      ['REB%', t.rebPct, q.rebPct, 'pct'],
      ['Defensive rating', t.defRtg, q.defRtg],
      ['Net rating', t.netRtg, q.netRtg],
      ['Plus-minus / 36', t.plusMinus36, q.plusMinus36],
      ['PIE', t.pie, q.pie, 'pct'],
    ];

    const deep = [
      ['Paint scoring share', ts.pctPtsPaint, qs.pctPtsPaint, 'pct'],
      ['Mid-range scoring share', ts.pctPtsMidrange, qs.pctPtsMidrange, 'pct'],
      ['Catch-and-shoot FGA', ts.catchShootFga, qs.catchShootFga],
      ['Pull-up FGA', ts.pullUpFga, qs.pullUpFga],
      ['Paint PTS / 36', ts.paintPts36, qs.paintPts36],
      ['Self-created PTS / 36', ts.selfCreatedPts36, qs.selfCreatedPts36],
      ['Rim pressure profile', ts.rimPressure, qs.rimPressure],
      ['Self-creation profile', ts.selfCreation, qs.selfCreation],
      ['3-point volume profile', ts.threeVolume, qs.threeVolume],
      ['3-point accuracy profile', ts.threeAccuracy, qs.threeAccuracy],
      ['Playmaking profile', ts.playmaking, qs.playmaking],
      ['Rim protection profile', ts.rimProtection, qs.rimProtection],
    ].filter(([, a, b]) => fin(a) && fin(b));
    if (deep.length) rows.push(['DEEP STYLE (COMMON COVERAGE)', null, null, 'section'], ...deep);

    return `<div class="comp-side-table-wrap"><table class="comp-side-table">
      <thead><tr><th class="left">Comparison axis</th><th>${esc(set?.targetBasis === 'gleague-to-nba-equivalent' ? p.name + ' (NBA eq.)' : p.name)}</th><th>${esc(q.name)} · ${esc(q.season)}</th></tr></thead>
      <tbody>${rows.map(([label, a, b, type]) => type === 'section'
        ? `<tr class="comp-section-row"><th colspan="3">${esc(label)}</th></tr>`
        : `<tr><th class="left">${esc(label)}</th><td>${type === 'text' ? esc(a) : cval(a, type)}</td><td>${type === 'text' ? esc(b) : cval(b, type)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function compReferenceEvidence(profile) {
    if (!profile) return '<p class="tiny">Reference period unavailable.</p>';
    return `${profile.limited ? '<p class="comp-reference-limited">Single-season reference · limited history</p>' : ''}
      <details class="comp-reference-evidence"><summary>Reference evidence · ${profile.seasonCount} season${profile.seasonCount === 1 ? '' : 's'}</summary>
        <p class="tiny">Seasons included: ${esc((profile.seasons || []).join(', '))}. ${num(profile.games, 0)} games · ${num(profile.minutes, 0)} minutes.</p>
        <p class="tiny">Selected once for this player by playing-time exposure, before matching any target. Shooting percentages pool makes and attempts; rates are weighted by minutes. This describes a career stretch, not a whole-career average or a guaranteed peak. The team logo represents the highest-minute season in that stretch.</p>
      </details>`;
  }


  function rookieCohortComparison(p) {
    const evidence = p.proj?.why?.rookie;
    const neighbors = Array.isArray(evidence?.neighbors) ? evidence.neighbors : [];
    if (p.proj?.basis !== 'rookie-cohort-fallback' || !neighbors.length) return null;
    const cards = neighbors.map((x, i) => `
      <article class="comp-overall-card rookie-cohort-card">
        <span class="eyebrow">COHORT NEIGHBOR #${i + 1}</span>
        <h4>${esc(x.name || 'Historical rookie')}</h4>
        <p>${esc(x.rookieSeason || 'Rookie season')} · ${esc(x.position || '—')}
          ${fin(x.draftPick) ? ' · pick ' + num(x.draftPick, 0) : ' · undrafted/unknown slot'}</p>
        <p><b>${num(x.cohortWeightPct, 1)}%</b> of the historical cohort weight</p>
      </article>`).join('');
    return `<div class="comp-page">
      <div class="comp-page-title">
        <div><div class="eyebrow">HISTORICAL ROOKIE COHORT</div><h2>${esc(p.name)}</h2>
          <p class="tiny">Projection neighbors, not playing-style comps.</p></div>
      </div>
      ${compPlayerSearch(p)}
      <div class="ws-card wide">
        <p><b>This player has no NBA/G League professional sample to run through Player Comps.</b></p>
        <p class="tiny">Instead, the rookie projection exposes the historical entries carrying the most weight in its fallback cohort. The distance uses draft slot, positional class and entry age only. College/international production and scouting traits are not inputs, so these names must not be read as stylistic comparisons.</p>
      </div>
      <section class="comp-overall-section"><div><div class="eyebrow">MOST INFLUENTIAL ROOKIE PRIORS</div>
        <p class="tiny">${esc(evidence.neighborDefinition || '')}</p></div>
        <div class="comp-overall-grid">${cards}</div></section>
      <p class="tiny">Cohort: ${cval(evidence.peers, '—')} historical entries · effective peers ${cval(evidence.effectivePeers, '—')}. These percentages are shares of the full weighted cohort and therefore the five shown need not total 100%.</p>
    </div>`;
  }

  function viewSimilarity() {
    const p = compById(state.simPlayer) || byId(state.player) || players().find((x) => x.appeared) || players()[0];
    if (!p) return '<p class="loading">No players.</p>';
    state.simPlayer = p.playerId;
    const targetedSet = window.DATA?.analysis?.playerCompsTargeted?.[String(p.playerId)] || null;
    const isTargeted = !!targetedSet;
    const lg = isTargeted ? 'NBA' : (p.league === 'NBA' ? 'NBA' : 'GLEAGUE');
    const sameLeagueSet = isTargeted ? null : (window.DATA?.analysis?.playerComps?.[lg]?.[String(p.playerId)] || null);
    const nbaEquivalentSet = isTargeted ? null : (window.DATA?.analysis?.playerCompsNbaEquivalent?.[lg]?.[String(p.playerId)] || null);
    const useNbaEquivalent = isTargeted || (!!nbaEquivalentSet && (state.simCompScope === 'nba' || !sameLeagueSet));
    const set = targetedSet || (useNbaEquivalent ? nbaEquivalentSet : sameLeagueSet);
    const meta = window.DATA?.analysis?.playerCompsMeta || {};

    if (!set) {
      const rookie = rookieCohortComparison(p);
      if (rookie) return rookie;
      const reason = p.currentRoster&&!p.appeared
        ? `${p.name} is on the current ${teamOf(p)} roster but has no 2025-26 NBA appearance, so the comparison engine has no target stat profile to match.`
        : `${p.name} has no usable 2025-26 professional sample for this comparison.`;
      return `<h2>Player Comps</h2>
        ${compPlayerSearch(p)}
        <div class="ws-card wide"><div class="eyebrow">COMPARISON UNAVAILABLE</div><p><b>${esc(reason)}</b></p>
        <p class="tiny">The site keeps the player searchable and shows his roster status, but it does not invent a player comp from no current-season stat line.</p></div>
        <p class="tiny">Comparisons never invent production or body measurements for players without data.</p>`;
    }

    const targetPhysical = set.targetPhysical || {};
    const shown = set.top3 || [];
    const nearestOverall = set.nearestOverall || [];
    const blend = set.blend || [];
    const shareById = new Map(blend.map((x) => [String(x.playerId), x]));
    const confidence = set.blendConfidence;
    const profileRead = set.profileRead || {};
    // No usable independent trait reference means no trait card, not a relabeled blend member.
    const blueprintComponents = (Array.isArray(profileRead.components) ? profileRead.components : [])
      .slice().sort((a, b) => (Number(a.narrativeOrder) || 0) - (Number(b.narrativeOrder) || 0));
    const blueprintRole = (item) => (item.evidence || []).map((key) => ({
      physical: 'FRAME', role: 'ROLE', scoring: 'SCORING', defense: 'DEFENSE',
    }[key] || 'STYLE')).join(' + ') || 'STYLE REFERENCE';
    const blueprintPlayers = blueprintComponents.map((item, i) => `
      <article class="comp-blueprint-player" data-comp-rank="${i + 1}">
        <div class="comp-blueprint-player-top"><span>${esc(blueprintRole(item))}</span><b>TRAIT FIT ${cval(item.fit, '—')}%</b></div>
        <h4>${esc(item.name || 'Historical reference')} · ${esc(item.referencePeriod?.period || item.season || '')}</h4>
        <p>${esc(item.phrase || 'Historical blend reference')}</p>
        ${compReferenceEvidence(item.referencePeriod)}
      </article>`).join('');

    const overallCards = nearestOverall.map((q, i) => `
      <article class="comp-overall-card">
        <span class="eyebrow">OVERALL MATCH #${i + 1}</span>
        <h4>${esc(q.name || 'Historical player')}</h4>
        <p>${esc(q.referenceProfile?.period || q.season || 'Historical profile')} · ${num(q.similarity, 1)}/100 match quality</p>
        ${compReferenceEvidence(q.referenceProfile)}
      </article>`).join('');

    const heroes = shown.map((q, i) => {
      const b = shareById.get(String(q.playerId)) || { share: Math.round(100 / Math.max(1, shown.length)), matchScore: q.similarity };
      const blendLabel = shown.length === 1 ? 'OF THE PLAYER COMP' : 'OF THE PLAYER BLEND';
      return `<article class="comp-hero-card" data-comp-rank="${i + 1}">
        <div class="comp-hero-rank">#${i + 1}</div>
        ${compLogo(q)}
        <div class="comp-hero-score">${b.share}%</div>
        <div class="comp-hero-strength">${blendLabel}</div>
        <h3>${esc(q.name)}</h3>
        <p class="comp-season">${esc(q.season)} · ${esc(q.team || '—')} · ${esc(q.position || '—')}</p>
        ${compReferenceEvidence(q.referenceProfile)}
        <p class="tiny">Match quality: <b>${num(q.similarity, 1)}/100</b> · ${esc(compStrength(q.similarity))}</p>
        <div class="comp-block-pills">
          <span>Physical <b>${compBlockScore(q, 'physical')}%</b></span>
          <span>Role <b>${compBlockScore(q, 'role')}%</b></span>
          <span>Scoring <b>${compBlockScore(q, 'scoring')}%</b></span>
          <span>Defense <b>${compBlockScore(q, 'defense')}%</b></span>
        </div>
      </article>`;
    }).join('');

    const details = shown.map((q, i) => {
      const b = shareById.get(String(q.playerId)) || { share: 0 };
      const similar = (q.mostSimilar || []).map(esc).join(', ') || '—';
      const diff = (q.biggestDifferences || []).map((x) => esc(x.label)).join(', ') || '—';
      return `<section class="comp-detail-card comp-card" data-comp-rank="${i + 1}">
        <div class="comp-detail-head">
          <div><div class="eyebrow">#${i + 1} SIDE-BY-SIDE · ${esc(q.season)}</div>
          <h3>${esc(p.name)} vs. ${esc(q.name)}</h3></div>
          <div><div class="comp-detail-score">${b.share}%</div><div class="tiny">blend share</div></div>
        </div>
        <p class="tiny"><b>Match quality:</b> ${num(q.similarity, 1)}/100 · <b>Strongest similarities:</b> ${similar}<br>
        <b>Biggest differences:</b> ${diff}</p>
        <details class="comp-side-table-disclosure"><summary>View complete side-by-side data</summary>
          ${compCompareTable(p, set, q)}
        </details>
      </section>`;
    }).join('');

    const scopeToggle = !isTargeted && sameLeagueSet && nbaEquivalentSet ? `
      <div class="comp-pool-toggle" role="group" aria-label="Historical comparison pool">
        <button id="simScopeSame" class="${useNbaEquivalent ? '' : 'active'}" type="button">Same-league history</button>
        <button id="simScopeNba" class="${useNbaEquivalent ? 'active' : ''}" type="button">NBA-equivalent history</button>
      </div>` : '';
    const referenceMinimum = useNbaEquivalent ? 300 : (lg === 'NBA' ? 300 : 200);
    const pageEyebrow = isTargeted
      ? (set.sourceMode === 'gleague' ? 'G LEAGUE → NBA HISTORICAL BLEND' : 'PRE-NBA → NBA HISTORICAL BLEND')
      : useNbaEquivalent ? 'NBA-EQUIVALENT HISTORICAL BLEND' : 'HISTORICAL PLAYER-SEASON BLEND';
    const poolLabel = isTargeted ? 'NBA historical comparison pool'
      : useNbaEquivalent ? 'NBA-equivalent history' : `${p.leagueLabel || (lg === 'NBA' ? 'NBA' : 'G League')} history`;
    const methodSecondParagraph = isTargeted
      ? (set.sourceMode === 'gleague'
        ? `This dedicated target uses ${esc(p.name)}'s recorded G League production from ${esc(set.targetSeason)} and translates it into NBA statistical space with the historical G League→NBA crossover model. His NBA statistics are not target inputs, and his own NBA identity is excluded from the candidate pool. Small G League samples are automatically shrunk toward league norms before matching.`
        : `This dedicated target uses ${esc(p.name)}'s ${esc(set.targetSeason)} pre-NBA production from ${esc(set.sourceTeam || 'his prior team/league')}. Per-40 volume is conservatively translated toward NBA rates, noisy shooting percentages are regressed toward NBA norms, and source exposure controls shrinkage. This is a playing-style analogy, not a rookie performance forecast. NBA statistics are not target inputs.`)
      : useNbaEquivalent
        ? `The target starts with ${esc(p.name)}'s recorded G League production (${esc(set.targetSeason)}), then each supported comparison axis is translated into NBA statistical space using same-player, same-season crossover samples through ${esc(set.translationEvidence?.trainingThrough || '2024-25')}. The translated target is then standardized against the 2025-26 NBA distribution and matched to NBA historical references. Listed body measurements are unchanged. G League MPG is excluded because it is not an NBA role forecast.`
        : 'Similarity uses player-season rates per 100 possessions where pace is available, then centers and scales each feature within the same league and season. Low-exposure lines are shrunk toward that season’s median (240-minute prior; MPG uses 20 games) before scoring. This reduces short-sample and era/tempo effects; it does not remove all uncertainty. The side-by-side table continues to show raw recorded statistics. Physical profiles use the available listed measurements, which may not be contemporaneous with the season.';

    return `<div class="comp-page">
      <div class="comp-page-title">
        <div><div class="eyebrow">${esc(pageEyebrow)}</div><p class="tiny">A concise statistical blueprint, followed by the supporting evidence.</p></div>
        <div class="comp-confidence"><span>STATISTICAL BLEND FIT</span><b>${fin(confidence) ? num(confidence, 1) + '/100' : '—'}</b></div>
      </div>
      <p class="tiny">The large percentage${shown.length === 1 ? ' is' : 's are'} the <b>blend composition</b> and always total 100%.
      Statistical blend fit is a heuristic reconstruction score, not a probability, calibrated confidence, scouting verdict, or career forecast.</p>
      <details class="comp-method-note"><summary>How historical rates are compared</summary>
        <p class="tiny">Each reference uses the same career stretch for every target: the highest-minute three-calendar-year window, preferring at least two qualifying seasons. Each season needs ${referenceMinimum} minutes. Ties favor the more recent window. A single qualifying season is allowed only as a visibly limited overall match or blend contributor—not as a style analogy. Open Reference evidence on a card for its exact seasons and sample.</p>
        <p class="tiny">${methodSecondParagraph}</p>
      </details>
      ${compPlayerSearch(p)}
      ${scopeToggle}
      <p class="tiny">Target: ${esc(set.targetSeason || '2025-26')} ${esc(set.targetSeasonType || 'Regular Season')}
      · ${cval(set.targetGames, '0')} games · ${cval(isTargeted && fin(set.sourceOriginalMinutes) ? set.sourceOriginalMinutes : set.targetMinutes, '0')} source minutes.
      ${isTargeted && set.sourceConfidence ? ' Source confidence: ' + esc(set.sourceConfidence) + '.' : ''}
      ${lg === 'GLEAGUE' && !useNbaEquivalent ? 'The main database combines Regular Season and Showcase Cup; this same-league historical comparison may use a different season scope.' : ''}</p>
      ${isTargeted ? '<p class="tiny comp-source-rule"><b>Source rule:</b> NBA statistics are not target inputs for this comparison, and the target player is excluded from the NBA reference pool.</p>' : ''}
      ${fin(isTargeted ? set.sourceOriginalMinutes : set.targetMinutes) && Number(isTargeted ? set.sourceOriginalMinutes : set.targetMinutes) < 300 ? '<p class="comp-outlier-note">Small source sample: fewer than 300 minutes. Treat the blend as provisional; additional games can substantially change the translated profile.</p>' : ''}
      <div class="comp-target-strip">
        <div><span class="eyebrow">TARGET</span><h3>${esc(p.name)}</h3>
          <p>${esc(teamContext(p))} · ${esc(p.position || '—')} · ${esc(physicalLine(targetPhysical))}</p></div>
        <div class="comp-pool-note">${esc(poolLabel)}<br>
          <span>${esc(meta.priority || '')}</span></div>
      </div>
      ${set.targetHistoryNote ? `<p class="comp-outlier-note">${esc(set.targetHistoryNote)}</p>` : ''}
      ${overallCards ? `<section class="comp-overall-section"><div><div class="eyebrow">CLOSEST OVERALL MATCHES</div><p class="tiny">Holistic matches across the available profile. These are ranked separately and do not determine the style blueprint or blend shares.</p></div><div class="comp-overall-grid">${overallCards}</div></section>` : ''}
      <section class="comp-style-read comp-blueprint" aria-labelledby="comp-style-heading">
        <div class="comp-blueprint-intro"><div class="comp-blueprint-target">
          <div class="eyebrow">PLAYER STYLE BLUEPRINT</div><h3 id="comp-style-heading">${esc(p.name)}</h3>
          <span class="comp-blueprint-position">${esc(profileRead.position || 'Player profile')}</span></div>
          <p class="comp-style-copy">${esc(profileRead.text || set.shorthand || 'A player-specific style read is not available for this record.')}</p></div>
        ${blueprintPlayers ? `<div class="comp-blueprint-players" aria-label="Historical player references">${blueprintPlayers}</div>` : ''}
        <p class="tiny comp-style-note">${esc(profileRead.caveat || 'These are statistical parallels, not claims of identical skill.')}</p>
      </section>
      <h3 class="comp-blend-heading">Blend contributors <span>· shares total 100%</span></h3>
      <div class="comp-hero-grid">${heroes}</div>
      <div class="comp-detail-stack">${details}</div>
      <p class="tiny comp-method"><b>Blend method:</b> from a balanced shortlist of 18 historical player candidates, the engine chooses one to three
      players and their non-negative percentages together. It minimizes the error between the target and the weighted blend across
        listed physical dimensions, role, creation, production, shot diet and defensive activity; all shares sum to 100%. Missing source
      fields and an unnecessary extra player are explicit penalties. Team ratings and plus-minus stay visible but do not steer the
      composition. <b>Statistical blend fit</b> combines reconstruction quality, individual match quality and feature coverage, so a
      unique player can still receive honest reference points without pretending the historical fit is strong.
      ${esc((meta.limitations || []).join(' '))}</p>
    </div>`;
  }

  /* -------------------------------------------------------- TEAM FIT MODE */
  function viewTeamFit() {
    const teams = window.DATA.analysis.teams[league()] || {};
    const names = Object.keys(teams).sort();
    const t = teams[state.team] || teams[names[0]];
    if (!t) return '<p class="loading">No team data.</p>';
    state.team = t.team;
    const needs = Object.entries(t.needs).sort((a, b) => b[1].need - a[1].need);
    const isTeamMember = (fit) => {
      const p = players().find((x) => String(x.playerId) === String(fit.playerId) && x.league === league());
      if (!p) return false;
      return league() === 'NBA' ? p.currentTeam === t.team
        : (p.teams || []).some((x) => x.team === t.team) || p.team === t.team;
    };
    const rosterBasis = league() === 'NBA'
      ? 'NBA needs use 2025–26 profiles assigned to the current 2026–27 roster.'
      : 'G League needs use 2025–26 team assignments and profiles.';
    const fitRow = (f) => `<tr>
      <td class="left"><button class="player-link" data-goto="${esc(f.playerId)}">${esc(f.name)}</button>${isTeamMember(f) ? `<span class="team-fit-member">${league() === 'NBA' ? 'Already on roster' : '2025–26 team member'}</span>` : ''}</td>
      <td>${gnum(f.grade)}</td><td><b>${f.score}/100</b></td>
      <td class="left tiny">${[...(f.strengths || []), ...(f.weaknesses || [])].map(esc).join('<br>') || '—'}</td></tr>`;
    const fitTable = (list) => `<div class="table-wrap"><table class="compare-table"><thead><tr>
      <th class="left">Player</th><th>Grade</th><th>Fit</th><th class="left">Why</th></tr></thead><tbody>${list.map(fitRow).join('')}</tbody></table></div>`;
    const topFits = (t.topFits || []).slice(0, 10);
    const remainingFits = (t.topFits || []).slice(10);
    return `<h2>Team fit — ${esc(t.team)}</h2>
      <div class="ws-controls"><label>Team<select id="tfTeam">
        ${names.map((n) => `<option value="${esc(n)}"${n === t.team ? ' selected' : ''}>${esc(n)}</option>`).join('')}
      </select></label><span class="tiny">${t.rosterSize} measured player profiles used in the team-need baseline</span></div>
      <p class="tiny">${rosterBasis} Players without a measured profile are omitted from the baseline.</p>
      <section><h3>Roster needs <span class="tiny">100 = biggest gap</span></h3>
        ${needs.map(([, v]) => bar(v.label, v.need)).join('')}</section>
      <details class="ws-disclosure"><summary>Roster strengths <span class="tiny">minutes-weighted percentile</span></summary><div class="ws-disclosure-body">
        ${needs.slice().reverse().map(([, v]) => bar(v.label, v.strength)).join('')}</div></details>
      <h3>Top ${(t.topFits || []).length} measured fit results</h3>
      <p class="tiny">Fit is <b>not</b> player quality or an acquisition recommendation. These are the highest-ranked measured profiles from the league-wide search, not a list of every player. Current or prior team members are retained and clearly tagged. A dash in “Why” means no individual strength crossed the display threshold; the score still uses every measured need.</p>
      ${fitTable(topFits)}
      ${remainingFits.length ? `<details class="ws-disclosure"><summary>Show ${remainingFits.length} more fit results</summary><div class="ws-disclosure-body">${fitTable(remainingFits)}</div></details>` : ''}`;
  }

  /* ------------------------------------------------------- ROLE VALUE MODE */
  /**
   * Role Value is a role-change question, so the UI leads with the scenario, then the evidence, then
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
    if (!p) return '<p class="loading">No Role Value data for this league.</p>';
    state.tulipPlayer = p.playerId;
    const t = p.tulip;
    if (!t?.card) {
      return `<section class="role-unavailable">
        <div class="ws-head"><div>${playerPicker('tuPlayer', p.playerId, 'Candidate')}</div>
          <div class="ws-title"><h2>${esc(p.name)}</h2><p class="tiny">${esc(p.leagueLabel)} · ${esc(teamContext(p))} · ${esc(p.position || '—')}</p></div></div>
        <div class="ws-card wide"><div class="eyebrow">ROLE VALUE UNAVAILABLE</div>
          <h3>No Role Value estimate</h3>
          <p>The published dataset has no Role Value estimate for this player. This is unavailable—not a zero score or a recommendation to play fewer minutes.</p>
          <p class="tiny">Current roster membership and a statistical projection do not establish enough role-change evidence. Select another player to explore an available estimate.</p>
        </div>
      </section>`;
    }
    const target = state.tulipTarget ?? t.defaultTarget;
    const card = t.card;
    const isDefault = Math.abs(target - card.targetMpg) < 0.001;
    const scenarios = [...t.frontier.filter((f) => Math.abs(f.mpg - card.targetMpg) >= 0.001),
      { ...card.projection, mpg: card.targetMpg, abstain: card.abstain,
        abstainReason: card.reason || card.abstainReason || card.projection?.abstainReason }].sort((a,b) => a.mpg-b.mpg);
    const band = scenarios.find((f) => Math.abs(f.mpg - target) < 0.001);
    // Rotation decisions were computed only for the exact default scenario.
    const rot = isDefault ? card.rotation : null;
    const rsr = t.roleScaleResponse || {};

    const scenario = `
      <div class="ws-controls">
        ${playerPicker('tuPlayer', p.playerId, 'Candidate')}
        <label>Target role
          <select id="tuTarget">${scenarios.map((f) =>
            `<option value="${f.mpg}"${f.mpg === target ? ' selected' : ''}>${f.mpg} MPG${f.abstain ? ' — no evidence' : ''}</option>`).join('')}</select>
        </label>
        <div class="ws-card"><div class="k">${esc(window.DATA?.season || '2025-26')} baseline role</div><div class="v">${num(p.mpg)}<span class="tiny"> mpg · ${p.gp} g</span></div></div>
        <div class="ws-card"><div class="k">Change</div><div class="v">${target > p.mpg ? '+' : ''}${num(target - p.mpg)}<span class="tiny"> mpg</span></div></div>
      </div>`;

    if (band && band.abstain) {
      return scenario + `<div class="tulip-abstain">
        <div class="eyebrow">INSUFFICIENT EVIDENCE</div>
        <h3>No projection at ${band.mpg} MPG</h3>
        <p>${esc(band.abstainReason || 'Not enough comparable players occupied this role.')}</p>
        <p class="tiny">This is <b>not</b> a prediction of decline. Role Value abstains rather than
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
        <div class="ws-card"><div class="k">Role Value support</div><div class="v">${proj ? proj.support : '—'}<span class="tiny">/100</span></div>
          <p class="tiny">${proj ? `${proj.comparables} comparables · effective n ${num(proj.effectiveN, 1)} · mean similarity ${num(proj.meanSimilarity, 1)}` : ''}</p></div>
        <div class="ws-card"><div class="k">Evidence tier</div><div class="v">${isDefault ? esc(card.evidenceTier?.tier || '—') : '—'}</div>
          <p class="tiny">${isDefault ? esc(card.evidenceTier?.label || '') : 'Target-specific evidence tier not computed.'}</p></div>
        <div class="ws-card"><div class="k">Role-Scale Response</div>
          <div class="v">${esc(rsr.response || '—')}</div>
          <p class="tiny">${fin(rsr.slopePer10Min) ? `${rsr.slopePer10Min > 0 ? '+' : ''}${rsr.slopePer10Min} per 10 mpg` : 'not enough supported bands'}</p></div>
      </div>

      ${rot && !rot.abstain ? `
      <h3>Two different questions <span class="tiny">deliberately not merged into one score</span></h3>
      <div class="ws-cols">
        <section class="read-block"><div class="eyebrow">PLAYER / LEAGUE READ</div>
          <p class="tiny">How this target-role projection compares with a typical NBA rotation player.
          A league-referenced role-expansion value — not context-free player quality.</p>
          <div class="v big">${num(rot?.leagueReferencedDelta, 2)}</div></section>
        <section class="read-block"><div class="eyebrow">TEAM DECISION READ</div>
          <p class="tiny">Whether reallocating minutes from realistic players on <b>${esc(teamOf(p))}</b>
          appears beneficial. Dominated by who currently holds those minutes.</p>
          <div class="v big">${num(rot?.neutralRotationDelta, 2)}</div></section>
      </div>
      <details class="ws-disclosure"><summary>Rotation Delta details <span class="tiny">decomposed, not one number</span></summary><div class="ws-disclosure-body">
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
      <p class="tiny">Minutes reallocated: ${num(rot.minutesReallocated)} from ${rot.displaced.map((x) => `${esc(x.name)} (-${x.minutesTaken})`).join(', ')}</p></div></details>
      ` : `<p class="tiny">No rotation delta: ${esc(rot?.reason || 'not computed for this target. Rotation decisions are available only at the default target; no default-scenario decision is reused here.')}</p>`}

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
        return src && src.topComparables ? `<details class="ws-disclosure"><summary>Closest comparables at ${target} MPG</summary><div class="ws-disclosure-body">
      <div class="table-wrap"><table class="compare-table"><thead><tr>
        <th class="left">Player</th><th>Similarity</th><th>MPG</th><th>On-court diff</th></tr></thead><tbody>
        ${src.topComparables.map((c) => `<tr><td class="left">${esc(c.name)} <span class="tiny">${esc(c.team)}</span></td>
          <td>${num(c.similarity, 1)}</td><td>${num(c.mpg)}</td><td>${num(c.netRtg, 1)}</td></tr>`).join('')}
      </tbody></table></div></div></details>`
          : '<p class="tiny">Named comparables are available only for the default scenario; other role bands report their comparable count and mean similarity above.</p>';
      })()}

      <details class="ws-disclosure"><summary>Method limits and residual bias</summary><div class="ws-disclosure-body">${(() => { const b = window.DATA?.tulipMeta?.validationSnapshot?.balance?.starterContext || {};
        const pooled = fin(b.pooledSmd) ? Number(b.pooledSmd).toFixed(3) : 'n/a';
        const worst = fin(b.worstBandSmd) ? Number(b.worstBandSmd).toFixed(3) : 'n/a';
        return `<p class="tiny"><b>Known residual bias.</b> Comparables at a large target role started a much
        larger share of their games than the candidate does. On this build the pooled starter-share
        SMD is ${pooled}, while the worst target band is ${esc(b.worstBand || '—')} at ${worst}.
        That gap is structural: a pool of bench players who play starter minutes barely exists.
        Direction is known; causal magnitude is not identified.</p>`; })()}
      ${comparablesNote()}</div></details>

      <details class="ws-disclosure"><summary>Best supported expansions in this league</summary><div class="ws-disclosure-body">
      <div class="table-wrap"><table class="compare-table"><thead><tr>
        <th class="left">Player</th><th>MPG</th><th>Target</th><th>League delta</th><th>Neutral delta</th><th>Support</th><th>Verdict</th></tr></thead><tbody>
        ${cands.filter((x) => !x.tulip.card.abstain && x.tulip.card.rotation && !x.tulip.card.rotation.abstain)
          .slice(0, 25).map((x) => `<tr>
          <td class="left"><button class="player-link" data-tulip="${esc(x.playerId)}">${esc(x.name)}</button>
            <span class="tiny">${esc(teamOf(x))}</span></td>
          <td>${num(x.mpg)}</td><td>${num(x.tulip.card.targetMpg)}</td>
          <td><b>${num(x.tulip.card.rotation.leagueReferencedDelta, 2)}</b></td>
          <td>${num(x.tulip.card.rotation.neutralRotationDelta, 2)}</td>
          <td>${x.tulip.card.projection.support}</td>
          <td class="tiny">${esc(x.tulip.card.rotation.verdict)}</td></tr>`).join('')}
      </tbody></table></div></div></details>`;
  }

  function comparablesNote() {
    return `<p class="tiny"><b>Not TULIP Capacity.</b> This is Role Value (TULIP Evidence v0.1), a different and separate tool: it asks what a bigger role would be WORTH on the player's current team. TULIP Capacity asks how many minutes he would SUSTAIN after an offseason move elsewhere. <b>What this is.</b> A comparable-based
      role-expansion estimator that currently consumes ONE season of aggregate and starter/bench
      split data. The project now contains ten seasons of historical game logs, but they are not
      yet used by this estimator. It is observational, not causal: comparables who already occupy
      a big role are selected, and that selection is not corrected for. On-court differential is
      a team result, shrunk toward the team mean but still unreliable in magnitude — read the sign
      and ordering, not the number. A multi-season forecast remains unavailable until the historical data
      are wired into a leakage-safe chronological validation pipeline and beat required baselines.</p>`;
  }

  /** Frontier: projected impact against target role, with support and abstention drawn apart. */
  function frontierBlock(t, target) {
    return `<h3>Role Value Frontier</h3>
      <p class="tiny">Blue band = 80% interval. Bar height = support. Hollow markers = the model
      has <b>no evidence</b> at that role, which is different from expecting decline.</p>
      <canvas id="tuCanvas" width="1000" height="380" style="width:100%;max-width:1000px" role="img" tabindex="0"
        data-target="${target}" aria-describedby="tuLegend"></canvas>
      <div id="tuLegend" class="tiny"></div>
      <details><summary>Accessible frontier data</summary><div id="tuData" class="table-wrap"></div></details>`;
  }

  function drawFrontier() {
    const cv = $('tuCanvas'); if (!cv) return;
    const p = byId(state.tulipPlayer); if (!p || !p.tulip) return;
    const pts = p.tulip.frontier;
    cv.setAttribute('aria-label', `Role Value Frontier for ${p.name}: target role in minutes per game versus projected on-court impact. Open Accessible frontier data for the underlying values.`);
    const dataTarget = $('tuData');
    if (dataTarget) dataTarget.innerHTML = `<table class="compare-table"><thead><tr><th>Target MPG</th><th>Projected impact</th><th>80% interval</th><th>Support</th><th>Evidence</th></tr></thead><tbody>${pts.map((f) => `<tr><td>${num(f.mpg)}</td><td>${f.abstain ? '—' : num(f.projectedImpact, 2)}</td><td>${f.abstain ? '—' : (f.interval ? `${num(f.interval[0], 2)} to ${num(f.interval[1], 2)}` : '—')}</td><td>${f.support ?? '—'}</td><td>${f.abstain ? 'Insufficient evidence' : 'Supported'}</td></tr>`).join('')}</tbody></table>`;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, pad = 56;
    ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.body);
    const line = (css.getPropertyValue('--line') || '#273142').trim();
    const muted = (css.getPropertyValue('--muted') || '#9aabba').trim();
    const accent = (css.getPropertyValue('--accent') || '#e8402a').trim();
    const pos = (css.getPropertyValue('--pos') || '#157a45').trim();
    const warn = (css.getPropertyValue('--warn') || '#b7791f').trim();

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
    ctx.fillStyle = accent; ctx.globalAlpha = 0.14;
    for (const f of pts) {
      const h = ((f.support || 0) / 100) * (H - pad * 2) * 0.28;
      ctx.fillRect(PX(f.mpg) - 16, H - pad - h, 32, h);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, W - pad * 2, H - pad * 2);
    ctx.fillStyle = muted; ctx.font = '12px "Helvetica Neue", Helvetica, Arial, sans-serif';
    for (const f of pts) ctx.fillText(String(f.mpg), PX(f.mpg) - 8, H - pad + 18);
    for (let i = 0; i <= 4; i++) {
      const gy = ymin + ((ymax - ymin) * i) / 4;
      ctx.fillText(gy.toFixed(1), 8, PY(gy) + 4);
    }
    // zero line
    if (ymin < 0 && ymax > 0) {
      ctx.strokeStyle = muted; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad, PY(0)); ctx.lineTo(W - pad, PY(0)); ctx.stroke();
      ctx.setLineDash([]);
    }
    // uncertainty band across supported bands
    if (supported.length > 1) {
      ctx.fillStyle = accent; ctx.globalAlpha = 0.18;
      ctx.beginPath();
      supported.forEach((f, i) => { const y = f.interval ? f.interval[1] : f.projectedImpact;
        i ? ctx.lineTo(PX(f.mpg), PY(y)) : ctx.moveTo(PX(f.mpg), PY(y)); });
      for (let i = supported.length - 1; i >= 0; i--) {
        const f = supported[i]; const y = f.interval ? f.interval[0] : f.projectedImpact;
        ctx.lineTo(PX(f.mpg), PY(y));
      }
      ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();
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
        ctx.fillStyle = accent;
        ctx.beginPath(); ctx.arc(x, PY(f.projectedImpact), 5, 0, Math.PI * 2); ctx.fill();
      }
    }
    // current role marker
    if (fin(p.mpg) && p.mpg >= xmin && p.mpg <= xmax) {
      ctx.strokeStyle = pos; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(PX(p.mpg), pad); ctx.lineTo(PX(p.mpg), H - pad); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = pos; ctx.fillText('current ' + p.mpg.toFixed(1), PX(p.mpg) + 6, pad + 14);
    }
    // chosen target marker
    const tgt = Number(cv.dataset.target);
    if (fin(tgt) && tgt >= xmin && tgt <= xmax) {
      ctx.strokeStyle = warn; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(PX(tgt), pad); ctx.lineTo(PX(tgt), H - pad); ctx.stroke();
      ctx.fillStyle = warn; ctx.fillText('target ' + tgt, PX(tgt) + 6, pad + 30);
    }
    $('tuLegend').innerHTML = `X = target role (MPG) · Y = projected on-court impact ·
      faint bars = Role Value support at that role ·
      <span style="color:var(--pos)">green</span> = current role ·
      <span style="color:var(--warn)">amber</span> = selected target ·
      hollow marker = <b>insufficient evidence</b> (not a predicted decline)`;
  }

  /* ------------------------------------------------------------- wiring */
  function wire() {
    const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };
    on('scEditFilters', 'click', () => changeMode('database'));
    on('wsChooseCompare', 'click', () => changeMode('database'));
    on('scClearFilters', 'click', () => window.__siteClearAllFilters?.());
    document.querySelectorAll('[data-filter-clear]').forEach((b) => {
      b.onclick = () => window.__siteClearFilter?.(b.dataset.filterClear);
    });
    on('wsPlayerSel', 'change', (e) => { state.player = e.target.value; render(); window.__siteUrlChanged?.('push'); });
    on('wsFindSimilar', 'click', () => { state.simPlayer = state.player; changeMode('similarity'); });
    on('wsLoadHistoryGames', 'click', () => { const p = byId(state.player) || players()[0]; if (p) openHistoryGames(p); });
    const selectCompPlayer = (candidate) => {
      if (!candidate) return;
      state.simPlayer = candidate.playerId;
      if (!candidate.compTarget) state.player = candidate.playerId;
      state.simQuery = '';
      hideCompSuggestions();
      render();
      window.__siteUrlChanged?.('push');
    };
    const chooseCompPlayer = (raw, useActive = false) => {
      raw = String(raw || '').trim();
      const exact = compPool().find((p) => p.name.toLowerCase() === raw.toLowerCase())
        || compPool().find((p) => compPlayerLabel(p).toLowerCase() === raw.toLowerCase());
      const candidates = compSuggestionMatches(raw);
      const active = useActive && state.simActiveIndex >= 0 ? candidates[state.simActiveIndex] : null;
      selectCompPlayer(exact || active);
    };
    on('simSearch', 'focus', (e) => { state.simActiveIndex = -1; updateCompSuggestions(e.target.value); });
    on('simSearch', 'input', (e) => { state.simQuery = e.target.value; state.simActiveIndex = -1; updateCompSuggestions(e.target.value); });
    on('simSearch', 'keydown', (e) => {
      const candidates = compSuggestionMatches(e.target.value);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!state.simSuggestionsOpen) updateCompSuggestions(e.target.value);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        state.simActiveIndex = candidates.length
          ? (state.simActiveIndex < 0 ? (delta > 0 ? 0 : candidates.length - 1)
            : (state.simActiveIndex + delta + candidates.length) % candidates.length) : -1;
        updateCompSuggestions(e.target.value);
        $('simSuggestions')?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
      }
      if (e.key === 'Enter') { e.preventDefault(); chooseCompPlayer(e.target.value, true); }
      if (e.key === 'Escape') hideCompSuggestions();
    });
    on('simSearch', 'blur', () => window.setTimeout(() => {
      const box = $('simSuggestions');
      if (!box?.contains(document.activeElement)) hideCompSuggestions();
    }, 120));
    on('simSuggestions', 'focusout', (e) => {
      if (!e.currentTarget.contains(e.relatedTarget) && e.relatedTarget !== $('simSearch')) hideCompSuggestions();
    });
    on('simTeam', 'change', (e) => { state.simTeam = e.target.value; render(); window.__siteUrlChanged?.('push'); });
    on('simPosition', 'change', (e) => { state.simPosition = e.target.value; render(); window.__siteUrlChanged?.('push'); });
    on('simScopeSame', 'click', () => { state.simCompScope = 'same'; render(); window.__siteUrlChanged?.('push'); });
    on('simScopeNba', 'click', () => { state.simCompScope = 'nba'; render(); window.__siteUrlChanged?.('push'); });
    on('simSuggestions', 'click', (e) => {
      const b = e.target.closest('[data-sim-pick]');
      if (!b) return;
      selectCompPlayer(compById(b.dataset.simPick));
    });
    on('tfTeam', 'change', (e) => { state.team = e.target.value; render(); window.__siteUrlChanged?.('push'); });
    on('tuPlayer', 'change', (e) => { state.tulipPlayer = e.target.value; state.tulipTarget = null; render(); window.__siteUrlChanged?.('push'); });
    on('tuTarget', 'change', (e) => { state.tulipTarget = Number(e.target.value); render(); window.__siteUrlChanged?.('push'); });
    document.querySelectorAll('[data-tulip]').forEach((b) => {
      b.onclick = () => { state.tulipPlayer = b.dataset.tulip; state.tulipTarget = null; render(); window.__siteUrlChanged?.('push'); };
    });
    for (const [id, key] of [['scX', 'scatterX'], ['scY', 'scatterY'], ['scSize', 'scatterSize'], ['scColor', 'scatterColor']]) {
      on(id, 'change', (e) => { state[key] = e.target.value; render(); window.__siteUrlChanged?.('push'); });
    }
    document.querySelectorAll('[data-preset]').forEach((b) => {
      b.onclick = () => { const [x, y] = b.dataset.preset.split('|'); state.scatterX = x; state.scatterY = y; render(); window.__siteUrlChanged?.('push'); };
    });
    // Only workspace player links use data-goto as a player id. The persistent site navigation also
    // uses data-goto (stats/proj/comps); binding those here overwrote app.js and made the top-level
    // Player Comps tab flash the right title before incorrectly opening the Player mode.
    document.querySelectorAll('#workspace [data-goto]').forEach((b) => {
      b.onclick = () => { state.player = b.dataset.goto; changeMode('player'); };
    });
  }

  window.__wsOpenPlayer = (id) => { state.player = id; changeMode('player'); };
  window.__wsInit = () => { render(); };
  window.__wsMode = () => MODE;
  window.__wsSetMode = (m, push = true) => changeMode(m, push);
  window.__wsRefresh = () => render();
  window.__wsUrlState = () => ({
    ...(state.player ? { player: state.player } : {}),
    ...(state.simPlayer ? { sim: state.simPlayer } : {}),
    ...(state.simTeam ? { simTeam: state.simTeam } : {}),
    ...(state.simPosition ? { simPosition: state.simPosition } : {}),
    ...(state.team ? { teamfit: state.team } : {}),
    ...(state.tulipPlayer ? { rolePlayer: state.tulipPlayer } : {}),
    ...(state.tulipTarget != null ? { target: state.tulipTarget } : {}),
    ...(state.scatterX !== 'usg' ? { x: state.scatterX } : {}),
    ...(state.scatterY !== 'ts' ? { y: state.scatterY } : {}),
    ...(state.scatterSize ? { size: state.scatterSize } : {}),
    ...(state.scatterColor !== 'positionFamily' ? { color: state.scatterColor } : {}),
  });
  window.__wsRestoreUrlState = (x = {}) => {
    MODE = MODES.some(([key]) => key === x.mode) ? x.mode : 'database';
    const valid = (id) => id != null && pickerPlayers().some((p) => String(p.playerId) === String(id)) ? String(id) : null;
    const validSim = (id) => id != null && compPickerPlayers().some((p) => String(p.playerId) === String(id)) ? String(id) : null;
    state.player = valid(x.player); state.simPlayer = validSim(x.sim);
    state.simTeam = x.simTeam || ''; state.simPosition = x.simPosition || '';
    state.team = x.teamfit || null; state.tulipPlayer = valid(x.rolePlayer);
    state.tulipTarget = fin(x.target) && Number(x.target) >= 0 && Number(x.target) <= 48 ? Number(x.target) : null;
    if (numericFields().some((f) => f.key === x.x)) state.scatterX = x.x;
    if (numericFields().some((f) => f.key === x.y)) state.scatterY = x.y;
    if (!x.size || numericFields().some((f) => f.key === x.size)) state.scatterSize = x.size || '';
    if (['positionFamily', 'team', 'ageBand', 'primaryArchetype'].includes(x.color)) state.scatterColor = x.color;
  };

  /**
   * Self-initialise. app.js also calls __wsInit, but in the standalone build its init() runs
   * from either a network JSON file or the standalone compressed payload. Waiting for DATA here
   * covers both paths without coupling workspace initialization to transport timing.
   */
  (function boot(tries = 0) {
    if (window.DATA && window.__wsLeague && document.getElementById('modeNav')) { render(); return; }
    if (tries > 400) return;
    setTimeout(() => boot(tries + 1), 25);
  })();
})();
