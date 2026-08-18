(() => {
  const $ = (id) => document.getElementById(id);
  const fin = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const num = (v, d = 1) => fin(v) ? Number(v).toFixed(d) : '—';
  const int = (v) => fin(v) ? Math.round(Number(v)).toLocaleString() : '—';

  let PRODUCT = null;
  let META = new Map();
  let ALL = [];
  let FILTERED = [];
  let AGG = [];
  let PAGE = 0;
  let IX = {};

  function rehydrate(d) {
    if (!d || d.encoding !== 'columnar-v1') return d;
    const ABSENT = d.absent ?? '\u0000~';
    const out = { ...d, encoding: 'rehydrated', leagues: {} };
    for (const lg of Object.keys(d.leagues || {})) {
      const { flatKeys, statKeys, customKeys, compKeys, rows } = d.leagues[lg];
      const put = (target, keys, vals) => keys.forEach((k, i) => { if (vals[i] !== ABSENT) target[k] = vals[i]; });
      out.leagues[lg] = rows.map(([flat, stats, custom, comps, teams]) => {
        const p = {};
        put(p, flatKeys, flat);
        p.stats = {}; put(p.stats, statKeys, stats);
        p.custom = {}; put(p.custom, customKeys, custom);
        p.components = {}; put(p.components, compKeys, comps);
        p.teams = teams || [];
        return p;
      });
    }
    return out;
  }

  async function gunzipJson(bytes) {
    if (typeof DecompressionStream !== 'function') throw new Error('History Lab requires a modern browser with DecompressionStream support.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  async function load() {
    $('hStatus').textContent = 'Loading compressed game logs…';
    const [histResp, dataResp] = await Promise.all([
      fetch('./public/history-games.json.gz', { cache: 'no-store' }),
      fetch('./public/data.json', { cache: 'no-store' }),
    ]);
    if (!histResp.ok) throw new Error(`history-games.json.gz returned ${histResp.status}`);
    if (!dataResp.ok) throw new Error(`data.json returned ${dataResp.status}`);
    PRODUCT = await gunzipJson(new Uint8Array(await histResp.arrayBuffer()));
    if (PRODUCT?.schemaVersion !== 1 || !Array.isArray(PRODUCT?.rowSchema) || !PRODUCT?.byPlayer) {
      throw new Error('Unsupported historical game-log artifact.');
    }
    const data = rehydrate(await dataResp.json());
    IX = Object.fromEntries(PRODUCT.rowSchema.map((k, i) => [k, i]));

    for (const [league, list] of Object.entries(data.leagues || {})) {
      for (const p of list) {
        const id = String(p.nbaPersonId ?? p.playerId);
        const prev = META.get(id) || { leagues: new Set(), teams: new Set() };
        prev.name = prev.name || p.name || `Player ${id}`;
        prev.leagues.add(league === 'GLEAGUE' ? 'G League' : 'NBA');
        if (p.team) prev.teams.add(p.team);
        META.set(id, prev);
      }
    }

    for (const [playerId, rows] of Object.entries(PRODUCT.byPlayer)) {
      if (!META.has(playerId)) META.set(playerId, { name: `Player ${playerId}`, leagues: new Set(['NBA history']), teams: new Set() });
      for (const row of rows) ALL.push({ playerId, row });
    }

    populateFilters();
    bind();
    apply();
    $('hStatus').textContent = `${ALL.length.toLocaleString()} player-game rows loaded · ${META.size.toLocaleString()} current-database identities indexed`;
  }

  function val(entry, key) { return entry.row[IX[key]]; }
  function playerName(id) { return META.get(String(id))?.name || `Player ${id}`; }

  function populateFilters() {
    const seasons = PRODUCT.seasons || [...new Set(ALL.map((e) => val(e, 'season')))].sort();
    $('hSeason').innerHTML = '<option value="">All seasons</option>' + seasons.map((s) => `<option>${esc(s)}</option>`).join('');
    const teams = [...new Set(ALL.map((e) => val(e, 'team')).filter(Boolean))].sort();
    const opps = [...new Set(ALL.map((e) => val(e, 'opponent')).filter(Boolean))].sort();
    $('hTeam').innerHTML = '<option value="">All teams</option>' + teams.map((s) => `<option>${esc(s)}</option>`).join('');
    $('hOpponent').innerHTML = '<option value="">All opponents</option>' + opps.map((s) => `<option>${esc(s)}</option>`).join('');
  }

  function filters() {
    return {
      q: fold($('hPlayer').value), season: $('hSeason').value, phase: $('hPhase').value,
      team: $('hTeam').value, opponent: $('hOpponent').value, started: $('hStarted').value,
      from: $('hFrom').value, to: $('hTo').value,
      minMinutes: Number($('hMinMinutes').value) || 0, minGames: Math.max(1, Number($('hMinGames').value) || 1),
      sort: $('hSort').value, rawLimit: Math.max(1, Number($('hRawLimit').value) || 100),
    };
  }

  function rowMatches(e, f) {
    if (f.q && !fold(playerName(e.playerId)).includes(f.q)) return false;
    if (f.season && val(e, 'season') !== f.season) return false;
    if (f.phase && val(e, 'seasonType') !== f.phase) return false;
    if (f.team && val(e, 'team') !== f.team) return false;
    if (f.opponent && val(e, 'opponent') !== f.opponent) return false;
    const date = String(val(e, 'gameDate') || '');
    if (f.from && date < f.from) return false;
    if (f.to && date > f.to) return false;
    if ((Number(val(e, 'minutes')) || 0) < f.minMinutes) return false;
    const st = val(e, 'started');
    if (f.started === 'true' && st !== true) return false;
    if (f.started === 'false' && st !== false) return false;
    if (f.started === 'unknown' && st !== null) return false;
    return true;
  }

  function aggregate(rows, f) {
    const map = new Map();
    for (const e of rows) {
      let a = map.get(e.playerId);
      if (!a) {
        a = { playerId: e.playerId, name: playerName(e.playerId), games: 0, minutes: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, plusMinus: 0,
          starts: 0, knownStarts: 0, teams: new Set(), seasons: new Set(), first: null, last: null };
        map.set(e.playerId, a);
      }
      a.games++;
      for (const k of ['minutes', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'plusMinus']) a[k] += Number(val(e, k)) || 0;
      const st = val(e, 'started');
      if (typeof st === 'boolean') { a.knownStarts++; if (st) a.starts++; }
      if (val(e, 'team')) a.teams.add(val(e, 'team'));
      if (val(e, 'season')) a.seasons.add(val(e, 'season'));
      const d = String(val(e, 'gameDate') || '');
      if (d && (!a.first || d < a.first)) a.first = d;
      if (d && (!a.last || d > a.last)) a.last = d;
    }
    const out = [...map.values()].filter((a) => a.games >= f.minGames);
    for (const a of out) {
      for (const k of ['minutes', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'plusMinus']) a[k + 'Pg'] = a[k] / a.games;
      a.startPct = a.knownStarts ? a.starts / a.knownStarts : null;
    }
    const key = f.sort;
    out.sort((a, b) => {
      const av = key === 'games' ? a.games : key === 'starts' ? a.starts : a[key + 'Pg'];
      const bv = key === 'games' ? b.games : key === 'starts' ? b.starts : b[key + 'Pg'];
      return (Number(bv) || 0) - (Number(av) || 0) || a.name.localeCompare(b.name);
    });
    return out;
  }

  function apply() {
    const f = filters();
    FILTERED = ALL.filter((e) => rowMatches(e, f));
    AGG = aggregate(FILTERED, f);
    PAGE = 0;
    renderSummary();
    renderPlayers();
    renderGames();
  }

  function renderSummary() {
    const games = new Set(FILTERED.map((e) => String(val(e, 'gameId')))).size;
    const players = new Set(FILTERED.map((e) => e.playerId)).size;
    const teams = new Set(FILTERED.map((e) => val(e, 'team')).filter(Boolean)).size;
    const known = FILTERED.filter((e) => typeof val(e, 'started') === 'boolean').length;
    const dates = FILTERED.map((e) => String(val(e, 'gameDate') || '')).filter(Boolean).sort();
    const cards = [
      ['Player-games', FILTERED.length.toLocaleString()], ['Players', players.toLocaleString()], ['Games', games.toLocaleString()],
      ['Teams', teams.toLocaleString()], ['Starter known', FILTERED.length ? `${(100 * known / FILTERED.length).toFixed(1)}%` : '—'],
      ['Date span', dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : '—'],
    ];
    $('hSummary').innerHTML = cards.map(([k, v]) => `<div class="history-card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
  }

  function renderPlayers() {
    const body = $('hPlayerTable').querySelector('tbody');
    if (!AGG.length) { body.innerHTML = '<tr><td colspan="12" class="history-empty">No players match this slice.</td></tr>'; return; }
    body.innerHTML = AGG.slice(0, 250).map((a) => {
      const meta = META.get(String(a.playerId));
      const sub = `${[...a.teams].sort().join('/')} · ${[...a.seasons].sort().join(', ')}${meta?.leagues?.size ? ` · current: ${[...meta.leagues].join('/')}` : ''}`;
      return `<tr><td><span class="history-player">${esc(a.name)}</span><span class="history-sub">${esc(sub)}</span></td>
        <td>${a.games}</td><td>${a.knownStarts ? `${a.starts}/${a.knownStarts}` : '—'}</td><td>${a.startPct === null ? '—' : `${(a.startPct * 100).toFixed(1)}%`}</td>
        <td>${num(a.minutesPg)}</td><td><b>${num(a.ptsPg)}</b></td><td>${num(a.rebPg)}</td><td>${num(a.astPg)}</td><td>${num(a.stlPg)}</td><td>${num(a.blkPg)}</td><td>${num(a.tovPg)}</td><td>${num(a.plusMinusPg)}</td></tr>`;
    }).join('');
  }

  function renderGames() {
    const f = filters();
    const sorted = FILTERED.slice().sort((a, b) => String(val(b, 'gameDate')).localeCompare(String(val(a, 'gameDate'))) || String(val(b, 'gameId')).localeCompare(String(val(a, 'gameId'))) || playerName(a.playerId).localeCompare(playerName(b.playerId)));
    const pages = Math.max(1, Math.ceil(sorted.length / f.rawLimit));
    PAGE = Math.min(PAGE, pages - 1);
    const chunk = sorted.slice(PAGE * f.rawLimit, (PAGE + 1) * f.rawLimit);
    const body = $('hGameTable').querySelector('tbody');
    body.innerHTML = chunk.length ? chunk.map((e) => {
      const st = val(e, 'started');
      return `<tr><td class="history-raw-name"><span class="history-player">${esc(playerName(e.playerId))}</span></td><td>${esc(val(e, 'gameDate'))}</td><td>${esc(val(e, 'season'))}</td>
        <td>${val(e, 'seasonType') === 'Playoffs' ? 'PO' : 'RS'}</td><td>${esc(val(e, 'team'))}</td><td>${esc(val(e, 'opponent'))}</td>
        <td>${st === true ? 'Yes' : st === false ? 'No' : '—'}</td><td>${num(val(e, 'minutes'))}</td><td>${int(val(e, 'pts'))}</td><td>${int(val(e, 'reb'))}</td><td>${int(val(e, 'ast'))}</td><td>${int(val(e, 'stl'))}</td><td>${int(val(e, 'blk'))}</td><td>${int(val(e, 'tov'))}</td><td>${int(val(e, 'plusMinus'))}</td></tr>`;
    }).join('') : '<tr><td colspan="15" class="history-empty">No game rows match this slice.</td></tr>';
    $('hPage').textContent = sorted.length ? `Page ${PAGE + 1} of ${pages} · ${sorted.length.toLocaleString()} matching player-games` : '0 matching player-games';
    $('hPrev').disabled = PAGE <= 0;
    $('hNext').disabled = PAGE >= pages - 1;
  }

  function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
  function download(name, rows) {
    const blob = new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }
  function exportPlayers() {
    const rows = [['Player','Player ID','Games','Known starts','Known starter appearances','Start %','MPG','PTS','REB','AST','STL','BLK','TOV','PlusMinus','Teams','Seasons','First date','Last date']];
    for (const a of AGG) rows.push([a.name,a.playerId,a.games,a.starts,a.knownStarts,a.startPct === null ? '' : a.startPct,a.minutesPg,a.ptsPg,a.rebPg,a.astPg,a.stlPg,a.blkPg,a.tovPg,a.plusMinusPg,[...a.teams].sort().join('|'),[...a.seasons].sort().join('|'),a.first,a.last]);
    download('history-player-slice.csv', rows);
  }
  function exportGames() {
    const rows = [['Player','Player ID',...PRODUCT.rowSchema]];
    for (const e of FILTERED) rows.push([playerName(e.playerId), e.playerId, ...e.row]);
    download('history-game-rows.csv', rows);
  }

  function reset() {
    for (const id of ['hPlayer','hSeason','hPhase','hTeam','hOpponent','hStarted','hFrom','hTo']) $(id).value = '';
    $('hMinMinutes').value = '0'; $('hMinGames').value = '1'; $('hSort').value = 'pts'; $('hRawLimit').value = '100'; apply();
  }

  function bind() {
    for (const id of ['hPlayer','hSeason','hPhase','hTeam','hOpponent','hStarted','hFrom','hTo','hMinMinutes','hMinGames','hSort','hRawLimit']) {
      $(id).addEventListener(id === 'hPlayer' ? 'input' : 'change', apply);
    }
    $('hReset').onclick = reset;
    $('hExportPlayers').onclick = exportPlayers;
    $('hExportGames').onclick = exportGames;
    $('hPrev').onclick = () => { if (PAGE > 0) { PAGE--; renderGames(); } };
    $('hNext').onclick = () => { PAGE++; renderGames(); };
  }

  window.__historyLab = {
    get rows() { return ALL.length; },
    get filteredRows() { return FILTERED.length; },
    get playerResults() { return AGG.length; },
    apply,
  };

  load().catch((err) => {
    console.error(err);
    $('hStatus').textContent = `History Lab failed to load: ${err.message}`;
    $('hStatus').classList.add('history-danger');
  });
})();
