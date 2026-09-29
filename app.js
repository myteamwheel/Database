const $ = id => document.getElementById(id);
let DATA = null;
let league = 'NBA';
let sortKey = 'grade';
let sortDir = -1;
let rules = [];
let compared = new Set();
let labConfig = [];
let labCohort = 'league';
let viewRankOf = new Map();
let restoringUrlState = false;

const URL_FILTER_FIELDS = {
  q: 'searchInput', team: 'teamFilter', pos: 'positionFilter', country: 'countryFilter',
  gp: 'minGp', mpg: 'minMpg', min: 'minMin', grade: 'minGrade', reliability: 'minReliability',
  rosterScope: 'rosterScope', teamMode: 'teamMode', view: 'viewPreset', sort: 'sortField', dir: 'sortOrder', rows: 'rowLimit',
};
const URL_ALLOWED_MODES = new Set(['database', 'player', 'compare', 'scatter', 'similarity', 'teamfit', 'tulip']);

function writeUrlState(kind = 'replace') {
  if (restoringUrlState || !DATA || location.protocol === 'file:') return;
  const params = new URLSearchParams();
  if (league !== 'NBA') params.set('league', league);
  const mode = window.__wsMode?.() || 'database';
  if (mode !== 'database') params.set('mode', mode);
  for (const [key, id] of Object.entries(URL_FILTER_FIELDS)) {
    const el = $(id);
    if (!el) continue;
    const value = el.type === 'checkbox' ? (el.checked ? '1' : '') : String(el.value || '');
    const defaults = { rosterScope: 'season', teamMode: 'season', view: 'overall', sort: 'grade', dir: '-1', rows: '50', gp: '0', mpg: '0', min: '0', grade: '0', reliability: '0' };
    if (value && value !== (defaults[key] ?? '')) params.set(key, value);
  }
  if ($('bothOnly')?.checked) params.set('both', '1');
  if ($('includeRosterOnly')?.checked) params.set('roster', '1');
  if (rules.length) params.set('rules', JSON.stringify(rules));
  const ids = [...compared];
  if (ids.length) params.set('compare', ids.join(','));
  const custom = labConfig.map((x) => [x.key, x.w]);
  if (custom.length) params.set('score', JSON.stringify({ fields: custom, cohort: labCohort,
    allowMixedScope: !!$('allowMixedScope')?.checked }));
  const ws = window.__wsUrlState?.() || {};
  for (const [key, value] of Object.entries(ws)) {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  const search = params.toString();
  const href = `${location.pathname}${search ? `?${search}` : ''}${location.hash}`;
  if (href === `${location.pathname}${location.search}${location.hash}`) return;
  history[kind === 'push' ? 'pushState' : 'replaceState']({ databaseState: true }, '', href);
}

function restoreUrlState() {
  if (!DATA) return;
  restoringUrlState = true;
  try {
    const params = new URLSearchParams(location.search);
    const requestedLeague = params.get('league');
    if (requestedLeague === 'NBA' || requestedLeague === 'GLEAGUE') league = requestedLeague;
    document.querySelectorAll('.league-tab').forEach((b) => b.classList.toggle('active', b.dataset.league === league));
    populateSelectors(); fillMetricSelects();
    for (const [id, value] of Object.entries({ searchInput: '', teamFilter: '', positionFilter: '', countryFilter: '',
      minGp: '0', minMpg: '0', minMin: '0', minGrade: '0', minReliability: '0', rosterScope: 'season', teamMode: 'season',
      viewPreset: 'overall', rowLimit: '50', sortOrder: '-1' })) if ($(id)) $(id).value = value;
    sortKey = 'grade'; sortDir = -1;
    for (const [key, id] of Object.entries(URL_FILTER_FIELDS)) {
      if (!params.has(key)) continue;
      const el = $(id), value = params.get(key);
      const valid = el && (el.tagName === 'SELECT'
        ? [...el.options].some((o) => o.value === value)
        : ['number', 'search'].includes(el.type));
      if (valid) {
        el.value = value;
      }
    }
    if (location.hash === '#projections' && !params.has('view') && [...$('viewPreset').options].some((o) => o.value === 'proj')) {
      $('viewPreset').value = 'proj'; sortKey = 'proj.pts';
    }
    $('bothOnly').checked = params.get('both') === '1';
    if ($('includeRosterOnly')) $('includeRosterOnly').checked = params.get('roster') === '1';
    rules = [];
    try {
      const parsed = JSON.parse(params.get('rules') || '[]');
      if (Array.isArray(parsed)) rules = parsed.filter((x) => x && typeof x.key === 'string'
        && metricRegistryKeys().includes(x.key) && ['>=', '<=', '>', '<'].includes(x.op)
        && Number.isFinite(Number(x.value))).slice(0, 12).map((x) => ({ key: x.key, op: x.op, value: Number(x.value) }));
    } catch { /* malformed shared rule state is ignored */ }
    compared = new Set((params.get('compare') || '').split(',').filter(Boolean)
      .filter((id) => currentPlayers().some((p) => String(p.playerId) === id)).slice(0, 5));
    labConfig = [];
    labCohort = 'league';
    for (let i = 1; i <= 4; i++) {
      $(`labMetric${i}`).value = '';
      $(`labWeight${i}`).value = '0';
    }
    $('allowMixedScope').checked = false;
    try {
      const score = JSON.parse(params.get('score') || 'null');
      if (Array.isArray(score?.fields)) labConfig = score.fields.filter((x) => Array.isArray(x)
        && metricRegistryKeys().includes(x[0]) && Number.isFinite(Number(x[1])) && Number(x[1]) !== 0).slice(0, 4)
        .map(([key, weight]) => ({ key, weight: Number(weight) }));
      if (['league', 'filtered'].includes(score?.cohort)) labCohort = score.cohort;
      for (let i = 1; i <= 4; i++) {
        const item = labConfig[i - 1];
        if (item) { $(`labMetric${i}`).value = item.key; $(`labWeight${i}`).value = String(item.weight); }
      }
      $('labCohort').value = labCohort;
      $('allowMixedScope').checked = score?.allowMixedScope === true;
    } catch { /* malformed custom-score state is ignored */ }
    applyLab();
    const nextSort = metricRegistryKeys().includes(params.get('sort')) ? params.get('sort') : sortKey;
    sortKey = nextSort;
    sortDir = params.get('dir') === '1' ? 1 : -1;
    window.__wsRestoreUrlState?.({
      mode: URL_ALLOWED_MODES.has(params.get('mode')) ? params.get('mode') : (location.hash === '#projections' ? 'database' : 'database'),
      player: params.get('player'), sim: params.get('sim'), simTeam: params.get('simTeam'),
      simPosition: params.get('simPosition'), teamfit: params.get('teamfit'), rolePlayer: params.get('rolePlayer'),
      target: params.get('target'), x: params.get('x'), y: params.get('y'), size: params.get('size'), color: params.get('color'),
    });
  } finally {
    restoringUrlState = false;
  }
}

window.__siteUrlChanged = writeUrlState;
window.__siteFilterSummary = () => {
  const rows = [];
  const labels = { q: ['Search', $('searchInput')?.value], team: ['Team', $('teamFilter')?.value],
    pos: ['Position', $('positionFilter')?.value], country: ['Country', $('countryFilter')?.value],
    gp: ['Min games', Number($('minGp')?.value) > 0 ? $('minGp').value : ''],
    mpg: ['Min MPG', Number($('minMpg')?.value) > 0 ? $('minMpg').value : ''],
    min: ['Min total minutes', Number($('minMin')?.value) > 0 ? $('minMin').value : ''],
    grade: ['Min grade', Number($('minGrade')?.value) > 0 ? $('minGrade').value : ''],
    reliability: ['Min reliability', Number($('minReliability')?.value) > 0 ? $('minReliability').value : ''] };
  for (const [key, [label, value]] of Object.entries(labels)) if (value) rows.push({ key, label, value });
  if ($('teamMode')?.value === 'only') rows.push({ key: 'teamMode', label: 'Team stats', value: 'Selected team only' });
  if ($('bothOnly')?.checked) rows.push({ key: 'both', label: 'League overlap', value: 'NBA and G League' });
  if (isCurrentNbaRosterView()) rows.push({ key: 'rosterScope', label: 'Roster view', value: 'Current NBA rosters' });
  else if ($('includeRosterOnly')?.checked) rows.push({ key: 'roster', label: 'Roster-only players', value: 'Included' });
  for (const [i, rule] of rules.entries()) rows.push({ key: `rule:${i}`, label: colDef(rule.key).label, value: `${rule.op} ${rule.value}` });
  return rows;
};
window.__siteClearFilter = (key) => {
  const ids = { q: 'searchInput', team: 'teamFilter', pos: 'positionFilter', country: 'countryFilter',
    gp: 'minGp', mpg: 'minMpg', min: 'minMin', grade: 'minGrade', reliability: 'minReliability' };
  if (key.startsWith('rule:')) rules.splice(Number(key.slice(5)), 1);
  else if (key === 'both') $('bothOnly').checked = false;
  else if (key === 'roster') $('includeRosterOnly').checked = false;
  else if (key === 'rosterScope') $('rosterScope').value = 'season';
  else if (key === 'teamMode') $('teamMode').value = 'season';
  else if (ids[key]) $(ids[key]).value = ['q', 'team', 'pos', 'country'].includes(key) ? '' : '0';
  render(); window.__wsRefresh?.(); writeUrlState('push');
};
window.__siteClearAllFilters = () => {
  reset(); writeUrlState('push'); window.__wsRefresh?.();
};

/** Reverse the columnar encoding used by the standalone build. */
function rehydrate(d) {
  if (!d || d.encoding !== 'columnar-v1') return d;   // idempotent: safe to call twice
  const ABSENT = d.absent ?? '\u0000~';
  const out = { ...d, encoding: 'rehydrated', leagues: {} };
  for (const lg of Object.keys(d.leagues)) {
    const { flatKeys, statKeys, customKeys, compKeys, rows } = d.leagues[lg];
    const put = (target, keys, vals) => {
      keys.forEach((k, i) => { if (vals[i] !== ABSENT) target[k] = vals[i]; });
    };
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

/** 2026-27 roster situation, as shown in the Status column. */
const PROJ_STATUS = { same: 'Returning', new: 'New team', unsigned: 'No NBA roster', 'nba-roster': 'On NBA roster', gleague: 'G League' };

const get = (p, key) => {
  // Never render an old 2025-26 team as if it were the player's present NBA team. Historical
  // team identity stays in seasonTeam and is shown beside the player when it adds context.
  if (key === 'team') return p.league === 'NBA' ? (p.currentTeam || 'No NBA roster') : (p.team ?? null);
  if (key === 'labScore') return p.labScore ?? null;
  if (key === 'viewRank') return viewRankOf.get(p.playerId) ?? null;
  if (key.startsWith('stats.')) return p.stats?.[key.slice(6)] ?? null;
  if (key.startsWith('custom.')) return p.custom?.[key.slice(7)] ?? null;
  if (key.startsWith('components.')) return p.components?.[key.slice(11)] ?? null;
  if (key.startsWith('skill.')) return p.skillProfile?.[key.slice(6)] ?? null;
  if (key.startsWith('opt.')) return p.optimal?.[key.slice(4)] ?? null;
  if (key === 'nbaReadiness') return p.nbaReadiness ?? null;
  if (key.startsWith('rb.')) return p.readinessBlocks?.[key.slice(3)] ?? null;
  if (key.startsWith('p36.')) return p.per36?.[key.slice(4)] ?? null;
  if (key.startsWith('p36n.')) return p.per36Nba?.[key.slice(5)] ?? null;
  if (key.startsWith('tb.')) {
    // TULIP Beta. Abstentions are real nulls so a player TULIP declined to judge sorts to the END,
    // never as 0.0 which would read as "already at the right workload".
    const c = p.tulipBeta;
    if (!c || c.abstain === true) return null;
    return c[key.slice(3)] ?? null;
  }
  if (key.startsWith('proj.')) {
    // 2026-27 projection. A player with no recent minutes has no projection: null, never 0.
    const c = p.proj;
    if (!c || c.abstain === true) return null;
    const sub = key.slice(5);
    if (sub === 'status') return PROJ_STATUS[c.status] ?? null;
    if (sub === 'lastPts') return p.pts ?? null;
    return c[sub] ?? null;
  }
  if (key.startsWith('tc.')) {
    // Projected Role MPG (frozen artifact TULIP_CAPACITY_V1). An abstention is a real null so the
    // player sorts to the END in both
    // directions — never 0.0, which would rank him as a genuine low-capacity player.
    const c = p.tulipCapacity;
    if (!c || c.abstain === true) return null;
    const sub = key.slice(3);
    if (sub === 'evidence') return c.supportCount ?? null;
    return c[sub] ?? null;
  }
  if (key.startsWith('tulip.')) {
    const c = p.tulip?.card;
    // An abstention is NOT a zero. Returning null puts the player at the end of the sort in both
    // directions instead of ranking him as mid-table or worst, which a 0 would do.
    if (!c || c.abstain === true) return null;
    const sub = key.slice(6);
    if (sub === 'leagueDelta') return c.rotation?.abstain ? null : (c.rotation?.leagueReferencedDelta ?? null);
    if (sub === 'neutralDelta') return c.rotation?.abstain ? null : (c.rotation?.neutralRotationDelta ?? null);
    if (sub === 'projectedImpact') return c.projection?.projectedImpact ?? null;
    if (sub === 'support') return c.projection?.support ?? null;
    if (sub === 'tier') return c.evidenceTier?.tier ?? null;
    if (sub === 'verdict') return c.rotation?.verdict ?? null;
    if (sub === 'targetMpg') return c.targetMpg ?? null;
    return null;
  }
  return p[key] ?? null;
};
const finite = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = v => finite(v) ? `${(Number(v)*100).toFixed(1)}%` : '—';
const pctPoints = v => finite(v) ? `${Number(v).toFixed(1)}%` : '—';
const num = (v,d=1) => finite(v) ? Number(v).toFixed(d) : '—';
const signed = (v,d=1) => finite(v) ? (Number(v)>0?'+':'')+Number(v).toFixed(d) : '—';
const median = vals => { const a=vals.filter(finite).map(Number).sort((x,y)=>x-y); if(!a.length)return null; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };
/** Strip diacritics so "Jokic" finds "Jokić" and "Doncic" finds "Dončić". */
const fold = s => String(s??'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();

const SRC_LABEL = {off:'Official',oadv:'Official Adv',omisc:'Official Misc',oscore:'Official Scoring',
  ousage:'Official Usage',odef:'Official Def',obio:'Bio',bref:'Basketball-Reference',hustle:'Hustle',
  trk:'Tracking',split:'Season split',op36:'Official Per36',op100:'Official Per100'};
const humanize = key => {
  const k = key.replace(/^stats\./,'').replace(/^custom\./,'').replace(/^components\./,'');
  const m = k.match(/^(off|oadv|omisc|oscore|ousage|odef|obio|bref|hustle|trk|split|op36|op100)_(.+)$/);
  const body = (m?m[2]:k).replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
  return m ? `${SRC_LABEL[m[1]]} · ${body}` : body;
};

const BASE_COLS = {
  select:{label:'',type:'select'},
  viewRank:{label:'#',type:'int',help:'Position in the current view'},
  rank:{label:'Overall',type:'int',help:'Grade rank across the whole league'},
  name:{label:'Player',type:'player'},
  team:{label:'Team',type:'text'}, teamCount:{label:'#Tm',type:'int'},
  position:{label:'Pos',type:'text'}, positionFamily:{label:'Pos family',type:'text'},
  positionSource:{label:'Pos src',type:'text'},
  age:{label:'Age',type:'int',help:'Age as listed by NBA.com'},
  ageOpeningNight:{label:'Age (open)',type:'int',help:'Exact age on opening night, 21 Oct 2025'},
  ageFeb1:{label:'Age (Feb 1)',type:'int',help:'Exact age on 1 Feb 2026 — the Basketball-Reference season-age convention'},
  seasonAge:{label:'Season Age (bref)',type:'int'},
  birthdate:{label:'Born',type:'text'},
  appeared:{label:'Played',type:'text'}, rosterOnly:{label:'Roster only',type:'text'},
  height:{label:'Ht',type:'text'}, heightInches:{label:'Ht (in)',type:'int'},
  weight:{label:'Wt',type:'int'}, college:{label:'College',type:'text'}, country:{label:'Country',type:'text'},
  jersey:{label:'#Jsy',type:'text'}, draftYear:{label:'Draft Yr',type:'text'}, draftRound:{label:'Rd',type:'text'},
  draftNumber:{label:'Pick',type:'text'}, draftStatus:{label:'Draft status',type:'text'},
  gp:{label:'GP',type:'int'}, gs:{label:'GS',type:'int'}, wins:{label:'W',type:'int'}, losses:{label:'L',type:'int'},
  regularGP:{label:'RS GP',type:'int'}, showcaseGP:{label:'Cup GP',type:'int'},
  mpg:{label:'MIN',type:'1'}, minutes:{label:'Total MIN',type:'int'},
  grade:{label:'Grade',type:'grade',help:'Per-game performance grade'},
  rateGrade:{label:'Rate Grade',type:'grade',help:'Same model per 36 minutes — on-court productivity'},
  magnitudeGrade:{label:'Magnitude',type:'grade',help:'Robust z-score model: how far production sits from normal, not standing. 2025-26 population only.'},
  magnitudeRaw:{label:'Magnitude z',type:'3',help:'Shrunk weighted robust z-score before mapping'},
  gradeCoverage:{label:'Coverage',type:'1',help:'Percent of declared grade ingredients this player actually had'},
  gradeRaw:{label:'Raw Score',type:'2'}, gradeShrunk:{label:'Shrunk Score',type:'2'},
  'tb.tulip':{label:'TULIP',type:'signed1',help:'WHAT: how many more (+) or fewer (-) minutes per game TULIP Beta RECOMMENDS for this player, under its heuristic, if the team\u0027s objective is to maximize winning. PLAIN: does this heuristic flag him as underutilized or overutilized by his current team? A positive value means the model recommends more minutes \u2014 it is not an established finding that he is being misused. FORMULA: starts from his team-relative value \u2014 shrunk BPM minus his team\u0027s minute-weighted average BPM, in league SD units \u2014 then compressed by three constraints: (1) WORKLOAD STATE, since a +1 SD player at 12 MPG has more room than one at 34; (2) ROLE EVIDENCE, which attenuates expansion where history does not support that workload; (3) ZERO-SUM ALLOCATION, so every minute granted is sourced from a team-mate and each team\u0027s ledger conserves. EXPERIMENTAL BETA: pre-registered causal testing on 2015-16 to 2023-24 did NOT establish that these exact deltas maximize wins (reduced form -0.127 pts/SD, 95% CI [-1.756, 1.021]). The DIRECTION is mechanically determined by team-relative value and the MAGNITUDE is heuristic. Neither the play-more/play-less direction nor the exact magnitude has been validated as a win-improving coaching prescription. Treat as decision support only. Blank means TULIP abstained \u2014 blank is NOT zero and always sorts last.'},
  'tb.currentMpg':{label:'Baseline MPG',type:'1',help:'WHAT: the 2025-26 MPG baseline TULIP is recommending a change FROM. In this preseason build, players are grouped by their current 2026-27 roster, but this workload is last season\'s MPG, not current-season 2026-27 playing time.'},
  'tb.recommendedMpg':{label:'Recommended MPG',type:'1',help:'WHAT: the workload this experimental allocator suggests from the 2025-26 MPG baseline. PLAIN: baseline workload after applying the TULIP reallocation. FORMULA: Baseline MPG + TULIP, bounded to the feasible 0-40 MPG range. Historical workload and Role Evidence reduce confidence and attenuate positive expansion, but they are not a hard ceiling: a strong breakout signal can recommend a workload above anything the player has previously sustained.'},
  'tb.confidence':{label:'Support',type:'text',help:'RECOMMENDATION SUPPORT; NOT PROBABILITY OF CORRECTNESS. HIGH / MEDIUM / LOW describes the strength of the DATA AND EVIDENCE behind the recommendation\u0027s inputs \u2014 sample size (minutes played), the role-evidence tier behind any expansion, and whether the recommended workload sits inside historically observed support. It does NOT mean the MPG recommendation is likely to be win-optimal. Nothing here claims "82% likely to be correct"; causal validation of the magnitude failed, so no such claim is available to make.'},
  'tb.valueGapSd':{label:'Value vs team (SD)',type:'signed2',help:'WHAT: his shrunk BPM minus his team\u0027s minute-weighted average BPM, in league standard-deviation units. PLAIN: how much better or worse he is than the average minute his team currently buys. This is the DIRECTION signal behind TULIP.'},
  'tb.supportedCeiling':{label:'Evidence-supported MPG',type:'1',help:'WHAT: the highest workload this player has already sustained or that Role Evidence directly supports. PLAIN: where the direct workload evidence ends. FORMULA: max(Baseline MPG, career-high MPG from 20+ game seasons, best 40+ game sustained-season MPG, highest non-abstaining Role Evidence frontier MPG), capped at 40. This is NOT a hard TULIP cap. A recommendation may exceed it when the team-relative signal is strong, but that part is extrapolation and therefore carries weaker support/confidence.'},
  'tc.capacityMpg':{label:'Projected Role MPG',type:'1',help:'WHAT: the MPG this player is likely to RECEIVE AND SUSTAIN after an offseason move to another NBA team. PLAIN: if a team signed or traded for him this offseason, what workload would he probably end up playing? THIS IS NOT A CAPACITY METRIC. It does not estimate how many minutes he could effectively handle. It predicts an observed rotation outcome, which is driven by coach preference, depth chart, roster construction, injuries, contract status and team strategy as much as by the player. A high-minute star can project LOWER than he currently plays simply because players at that workload historically regress after changing teams \u2014 that is a statement about rotations, not about the player. FORMULA: TULIP_CAPACITY_V1, a frozen linear model over his previous team\u0027s workload history (season MPG, recent-10, recent-5, trend, start rate, career games/seasons, career-high MPG), attributes (age, height, weight, draft slot) and production profile (GameScore/36, TS%, FGA/AST/REB/PF per 36). No destination-team information is used. SCOPE: validated for OFFSEASON acquisitions only; NOT validated for in-season trades. VALIDATED: on 970 offseason transitions the strongest simple baseline (previous-season MPG) has MAE 5.087 and the model has MAE 4.964 \u2014 an incremental gain of +0.122 MPG, 95% CI [0.035, 0.221]. Among two players with the same previous-season MPG it picks the one who ends up playing more 54.7% of the time versus 51.0% for the baseline, rising to 68.1% when it separates them by 5+ MPG. Real and statistically supported, but INCREMENTAL. The 50% range spans about 8.7 MPG, so use it to compare players, not as an exact forecast. Blank means the model abstained; blank is NOT zero and always sorts last. Model: TULIP_CAPACITY_V1, card-sha256:96cb2f34c6cd06c3.'},
  'tc.headroom':{label:'Proj vs Current',type:'signed1',help:'WHAT: Projected Role MPG minus his current season MPG. NOT "headroom" and NOT spare capacity \u2014 it is the difference between a projected rotation outcome and his current one. PLAIN: how much more (+) or less (-) he would probably play after an offseason move, versus now. FORMULA: Projected Role MPG - current season MPG. Positive does NOT mean he has unused capacity or that a team should play him more; it means comparable players ended up with more minutes after moving. Negative does NOT mean he is being overplayed. Blank when the model abstains.'},
  'tc.teamASeasonMpg':{label:'Current MPG',type:'1',help:'WHAT: his minutes per game this season \u2014 the workload the projection is made FROM, and the strongest simple baseline the model has to beat. PLAIN: what he actually played this year.'},
  'tc.interval50Low':{label:'Range low',type:'1',help:'Lower bound of the 50% likely range for Projected Role MPG, from the frozen V1 residual distribution. Half of comparable players landed inside this range; half did not.'},
  'tc.interval50High':{label:'Range high',type:'1',help:'Upper bound of the 50% likely range for Projected Role MPG, from the frozen V1 residual distribution. The range is about 8.7 MPG wide \u2014 individual predictions are not precise.'},
  'tc.evidence':{label:'Evidence',type:'int',help:'WHAT: the number of historical cross-team transitions with a similar Team A season MPG (within 3 MPG) behind this prediction. PLAIN: how much comparable history supports it. The letter grade shown in the player detail (A \u2265300, B \u2265150, C \u226560, D <60) is a CONVENIENCE LABEL FOR READABILITY, NOT A STATISTICAL GUARANTEE \u2014 the cutoffs were chosen for legibility and were not separately validated, which is why the raw count is the sortable value.'},
  // 2026-27 projection (PROJECTION_2026_27): per game, regular season, conditional on playing.
  'proj.team':{label:'Team',type:'text',help:'WHAT: the team he is on for 2026-27. PLAIN: where he plays next season, from the NBA\u0027s published 2026-27 rosters on the date shown above the table. FORMULA: stats.nba.com 2026-27 player index. A player with no 2026-27 NBA team keeps his 2025-26 team here; G League rows show the 2025-26 G League team.'},
  'proj.status':{label:'Status',type:'text',help:'WHAT: how his 2026-27 situation compares with 2025-26. PLAIN: Returning means the same team; New team means he changed teams in the offseason; No NBA team means he is not on a published 2026-27 roster yet and the line assumes he plays; On NBA roster marks a G League player who is on a 2026-27 NBA roster. FORMULA: 2026-27 roster team compared with his last 2025-26 team.'},
  'proj.age':{label:'Age',type:'int',help:'WHAT: his age during the 2026-27 season, on the NBA convention (age on February 1). PLAIN: age drives the aging adjustment in every projected stat.'},
  'proj.gp':{label:'GP',type:'int',help:'WHAT: projected games played, out of 82 (50 in the G League). PLAIN: how available he is likely to be. FORMULA: a model fitted on every NBA player-season since 2012-13 from the share of games he played in each of the last three seasons, games after the All-Star break, age, minutes and a team change, times 82. Assumes he is on a roster all season.'},
  'proj.mpg':{label:'MIN',type:'1',help:'WHAT: projected minutes per game. PLAIN: the role he is likely to have. FORMULA: a model fitted on every NBA player-season since 2012-13 from minutes in each of the last three seasons, minutes after the All-Star break, start rate, age, draft slot and experience for young players, productivity per possession, a team change, and how many minutes his 2026-27 teammates played last season.'},
  'proj.pts':{label:'PTS',type:'1',help:'WHAT: the central estimate of points per game in 2026-27. FORMULA: points from projected makes and free throws, adjusted for playing time, pace, roster-minute context and historical availability.'},
  'proj.ptsLo':{label:'PTS low',type:'1',help:'Historical reference bound from the prior veteran model residuals. It has not been calibrated for the current roster-minute reconciliation or rookie fallback.'},
  'proj.ptsHi':{label:'PTS high',type:'1',help:'Historical reference bound from the prior veteran model residuals. It has not been calibrated for the current roster-minute reconciliation or rookie fallback.'},
  'proj.reb':{label:'REB',type:'1',help:'WHAT: projected rebounds per game. FORMULA: offensive and defensive rebounds per 100 possessions, each projected on its own (three-season blend, position pull, age), x possessions per game.'},
  'proj.ast':{label:'AST',type:'1',help:'WHAT: projected assists per game. FORMULA: assists per 100 possessions (three-season blend, position pull, age, development, roster shot-creation balance, team change) x possessions per game.'},
  'proj.stl':{label:'STL',type:'1',help:'WHAT: projected steals per game. FORMULA: steals per 100 possessions (three-season blend, position pull, age) x possessions per game.'},
  'proj.blk':{label:'BLK',type:'1',help:'WHAT: projected blocks per game. FORMULA: blocks per 100 possessions (three-season blend, position pull, age) x possessions per game.'},
  'proj.tov':{label:'TOV',type:'1',help:'WHAT: projected turnovers per game. PLAIN: lower is better. FORMULA: turnovers per 100 possessions (three-season blend, position pull, age, roster balance, team change) x possessions per game.'},
  'proj.fg3m':{label:'3PM',type:'1',help:'WHAT: projected threes made per game. FORMULA: three-point attempts per 100 possessions x projected 3P% x possessions per game.'},
  'proj.fgPct':{label:'FG%',type:'pct',help:'WHAT: projected field goal percentage. FORMULA: (projected twos made + threes made) / projected field goal attempts, from separate 2P% and 3P% projections.'},
  'proj.fg3Pct':{label:'3P%',type:'pct',help:'WHAT: projected three-point percentage. PLAIN: three-point shooting is noisy, so a hot or cold season is pulled back hard. FORMULA: (weighted threes made + R x expected %) / (weighted attempts + R). The expected % rises with how often he shoots threes; the result is then adjusted for age.'},
  'proj.ftPct':{label:'FT%',type:'pct',help:'WHAT: projected free throw percentage. PLAIN: free-throw shooting is stable, so it stays close to his own record. FORMULA: three seasons of makes and attempts with a small pull toward his position average, then adjusted for age.'},
  'proj.ts':{label:'TS%',type:'pct',help:'WHAT: projected true shooting percentage. FORMULA: projected PTS / (2 x (FGA + 0.44 x FTA)).'},
  'proj.lastPts':{label:'25-26 PTS',type:'1',help:'WHAT: his actual 2025-26 points per game, for comparison. FORMULA: the same number as PTS in the season views.'},
  'proj.dPts':{label:'PTS chg',type:'signed1',help:'WHAT: projected 2026-27 points per game minus his 2025-26 average. PLAIN: whether he is expected to score more or less next season. FORMULA: projected PTS - 2025-26 PTS.'},
  'opt.gapVsTeam':{label:'Value vs team',type:'signed2',help:'WHAT: his shrunk BPM minus his team\'s minute-weighted average BPM. PLAIN: how much better or worse he is than the average minute his team currently buys. FORMULA: shrunk BPM - sum(BPM x minutes)/sum(minutes) across his eligible team-mates.'},
  'opt.shrunkBpm':{label:'BPM (shrunk)',type:'signed2',help:'WHAT: box plus/minus after pulling small samples toward the league average. PLAIN: his per-100-possession value including defence, with short samples trusted less. FORMULA: (minutes x BPM + 400 x leagueBPM) / (minutes + 400).'},
  'opt.bpm':{label:'BPM',type:'signed1',help:'WHAT: box plus/minus, points per 100 possessions above league average, offence and defence. PLAIN: his overall per-possession value. FORMULA: NBA uses Basketball-Reference BPM (OBPM + DBPM). The G League publishes no BPM, so it is PREDICTED by a least-squares model fitted on NBA players from inputs both leagues report - PIE, usage, true shooting, assist/rebound/turnover rates, steals and blocks per 100, net rating, free-throw rate and 3-point rate. Fit R2 0.92 in-sample, 0.90 on held-out players, RMSE 0.9 BPM points.'},
  nbaReadiness:{label:'NBA %',type:'1',help:'WHAT (G League only): modelled probability this player would be an effective NBA player. PLAIN: percent chance he holds his own in an NBA rotation. FORMULA: ridge logistic regression on five robust z-scored skill blocks \u2014 playmaking, connecting, defense, hustle proxy, 3PT efficiency \u2014 fitted on 85 players who logged 150+ minutes in BOTH leagues this season. "Effective" = NBA rate grade at or above the median of NBA players with 500+ minutes. SCORING VOLUME AND USAGE ARE EXCLUDED. Leave-one-out AUC 0.65, so it ranks better than chance but is far from decisive. Single season, and fitted only on players who already got an NBA call-up.'},
  'rb.playmaking':{label:'RB play',type:'2',help:'WHAT: playmaking block score inside NBA %. PLAIN: passing volume and ball security relative to the G League. FORMULA: mean robust z-score of assist rate, assists per 100 possessions, and assist-to-turnover ratio.'},
  'rb.connecting':{label:'RB connect',type:'2',help:'WHAT: connective-play block score. PLAIN: keeps the ball moving without coughing it up, and is willing to space the floor. FORMULA: weighted robust z of assist ratio (+1) and 3PT attempt rate (+0.6), minus turnover ratio (-1.2).'},
  'rb.defense':{label:'RB defense',type:'2',help:'WHAT: defensive block score. PLAIN: creates defensive events and defends without leaking points. FORMULA: weighted robust z of steals per 100 (+1), blocks per 100 (+1), defensive rebound rate (+0.7), and defensive rating inverted (-1).'},
  'rb.hustle':{label:'RB hustle',type:'2',help:'WHAT: hustle block score. PLAIN: effort plays. FORMULA: weighted robust z of offensive rebound rate (+1) and fouls drawn (+0.7). PROXY ONLY \u2014 the G League publishes no hustle tracking (deflections, screen assists, loose balls are NBA-only), so this is box-score effort, not tracked hustle.'},
  'rb.shooting':{label:'RB shooting',type:'2',help:'WHAT: three-point efficiency block score. PLAIN: can he shoot it, at real volume. FORMULA: robust z of 3PT% (+1) and 3PT attempts (+0.5), so a tiny-sample high percentage on no volume cannot carry the block.'},
  'p36.pts':{label:'PTS/36',type:'1',help:'WHAT: this player\u2019s own points per 36 minutes, in his own league. PLAIN: what his line looks like at a full starter workload, with the size of his role removed. FORMULA: (per-game points / MPG) x 36. No level translation \u2014 same league, same competition.'},
  'p36n.pts':{label:'PTS/36 NBA',type:'1',help:'WHAT (G League only): projected points per 36 minutes AGAINST NBA COMPETITION. PLAIN: what his line would look like as an NBA player at starter minutes. FORMULA: (per-game points / MPG) x 36 x level factor x pace factor. The level factor is the MEDIAN NBA-to-G-League ratio among 85 players who played 150+ minutes in both leagues this season; the pace factor is NBA median pace / G League median pace (101.8 / 103.8 = 0.981), because per-36 still contains possessions per minute and the two leagues do not play at the same speed.'},
  'p36.reb':{label:'REB/36',type:'1',help:'WHAT: this player\u2019s own rebounds per 36 minutes, in his own league. PLAIN: what his line looks like at a full starter workload, with the size of his role removed. FORMULA: (per-game rebounds / MPG) x 36. No level translation \u2014 same league, same competition.'},
  'p36n.reb':{label:'REB/36 NBA',type:'1',help:'WHAT (G League only): projected rebounds per 36 minutes AGAINST NBA COMPETITION. PLAIN: what his line would look like as an NBA player at starter minutes. FORMULA: (per-game rebounds / MPG) x 36 x level factor x pace factor. The level factor is the MEDIAN NBA-to-G-League ratio among 85 players who played 150+ minutes in both leagues this season; the pace factor is NBA median pace / G League median pace (101.8 / 103.8 = 0.981), because per-36 still contains possessions per minute and the two leagues do not play at the same speed.'},
  'p36.oreb':{label:'OREB/36',type:'1',help:'WHAT: this player\u2019s own offensive rebounds per 36 minutes, in his own league. PLAIN: what his line looks like at a full starter workload, with the size of his role removed. FORMULA: (per-game offensive rebounds / MPG) x 36. No level translation \u2014 same league, same competition.'},
  'p36n.oreb':{label:'OREB/36 NBA',type:'1',help:'WHAT (G League only): projected offensive rebounds per 36 minutes AGAINST NBA COMPETITION. PLAIN: what his line would look like as an NBA player at starter minutes. FORMULA: (per-game offensive rebounds / MPG) x 36 x level factor x pace factor. The level factor is the MEDIAN NBA-to-G-League ratio among 85 players who played 150+ minutes in both leagues this season; the pace factor is NBA median pace / G League median pace (101.8 / 103.8 = 0.981), because per-36 still contains possessions per minute and the two leagues do not play at the same speed.'},
  'p36.dreb':{label:'DREB/36',type:'1',help:'WHAT: this player\u2019s own defensive rebounds per 36 minutes, in his own league. PLAIN: what his line looks like at a full starter workload, with the size of his role removed. FORMULA: (per-game defensive rebounds / MPG) x 36. No level translation \u2014 same league, same competition.'},
  'p36n.dreb':{label:'DREB/36 NBA',type:'1',help:'WHAT (G League only): projected defensive rebounds per 36 minutes AGAINST NBA COMPETITION. PLAIN: what his line would look like as an NBA player at starter minutes. FORMULA: (per-game defensive rebounds / MPG) x 36 x level factor x pace factor. The level factor is the MEDIAN NBA-to-G-League ratio among 85 players who played 150+ minutes in both leagues this season; the pace factor is NBA median pace / G League median pace (101.8 / 103.8 = 0.981), because per-36 still contains possessions per minute and the two leagues do not play at the same speed.'},
  'p36.ast':{label:'AST/36',type:'1',help:'WHAT: this player\u2019s own assists per 36 minutes, in his own league. PLAIN: what his line looks like at a full starter workload, with the size of his role removed. FORMULA: (per-game assists / MPG) x 36. No level translation \u2014 same league, same competition.'},
  'p36n.ast':{label:'AST/36 NBA',type:'1',help:'WHAT (G League only): projected assists per 36 minutes AGAINST NBA COMPETITION. PLAIN: what his line would look like as an NBA player at starter minutes. FORMULA: (per-game assists / MPG) x 36 x level factor x pace factor. The level factor is the MEDIAN NBA-to-G-League ratio among 85 players who played 150+ minutes in both leagues this season; the pace factor is NBA median pace / G League median pace (101.8 / 103.8 = 0.981), because per-36 still contains possessions per minute and the two leagues do not play at the same speed.'},
  'p36.stl':{label:'STL/36',type:'1',help:'WHAT: this player\u2019s own steals per 36 minutes, in his own league. PLAIN: what his line looks like at a full starter workload, with the size of his role removed. FORMULA: (per-game steals / MPG) x 36. No level translation \u2014 same league, same competition.'},
  'p36n.stl':{label:'STL/36 NBA',type:'1',help:'WHAT (G League only): projected steals per 36 minutes AGAINST NBA COMPETITION. PLAIN: what his line would look like as an NBA player at starter minutes. FORMULA: (per-game steals / MPG) x 36 x level factor x pace factor. The level factor is the MEDIAN NBA-to-G-League ratio among 85 players who played 150+ minutes in both leagues this season; the pace factor is NBA median pace / G League median pace (101.8 / 103.8 = 0.981), because per-36 still contains possessions per minute and the two leagues do not play at the same speed.'},
  'p36.blk':{label:'BLK/36',type:'1',help:'WHAT: this player\u2019s own blocks per 36 minutes, in his own league. PLAIN: what his line looks like at a full starter workload, with the size of his role removed. FORMULA: (per-game blocks / MPG) x 36. No level translation \u2014 same league, same competition.'},
  'p36n.blk':{label:'BLK/36 NBA',type:'1',help:'WHAT (G League only): projected blocks per 36 minutes AGAINST NBA COMPETITION. PLAIN: what his line would look like as an NBA player at starter minutes. FORMULA: (per-game blocks / MPG) x 36 x level factor x pace factor. The level factor is the MEDIAN NBA-to-G-League ratio among 85 players who played 150+ minutes in both leagues this season; the pace factor is NBA median pace / G League median pace (101.8 / 103.8 = 0.981), because per-36 still contains possessions per minute and the two leagues do not play at the same speed.'},
  'p36.tov':{label:'TOV/36',type:'1',help:'WHAT: this player\u2019s own turnovers per 36 minutes, in his own league. PLAIN: what his line looks like at a full starter workload, with the size of his role removed. FORMULA: (per-game turnovers / MPG) x 36. No level translation \u2014 same league, same competition.'},
  'p36n.tov':{label:'TOV/36 NBA',type:'1',help:'WHAT (G League only): projected turnovers per 36 minutes AGAINST NBA COMPETITION. PLAIN: what his line would look like as an NBA player at starter minutes. FORMULA: (per-game turnovers / MPG) x 36 x level factor x pace factor. The level factor is the MEDIAN NBA-to-G-League ratio among 85 players who played 150+ minutes in both leagues this season; the pace factor is NBA median pace / G League median pace (101.8 / 103.8 = 0.981), because per-36 still contains possessions per minute and the two leagues do not play at the same speed.'},
  'p36.pf':{label:'PF/36',type:'1',help:'WHAT: this player\u2019s own fouls per 36 minutes, in his own league. PLAIN: what his line looks like at a full starter workload, with the size of his role removed. FORMULA: (per-game fouls / MPG) x 36. No level translation \u2014 same league, same competition.'},
  'p36n.pf':{label:'PF/36 NBA',type:'1',help:'WHAT (G League only): projected fouls per 36 minutes AGAINST NBA COMPETITION. PLAIN: what his line would look like as an NBA player at starter minutes. FORMULA: (per-game fouls / MPG) x 36 x level factor x pace factor. The level factor is the MEDIAN NBA-to-G-League ratio among 85 players who played 150+ minutes in both leagues this season; the pace factor is NBA median pace / G League median pace (101.8 / 103.8 = 0.981), because per-36 still contains possessions per minute and the two leagues do not play at the same speed.'},
  'p36.fg3':{label:'3PM/36',type:'1',help:'WHAT: this player\u2019s own made threes per 36 minutes, in his own league. PLAIN: what his line looks like at a full starter workload, with the size of his role removed. FORMULA: (per-game made threes / MPG) x 36. No level translation \u2014 same league, same competition.'},
  'p36n.fg3':{label:'3PM/36 NBA',type:'1',help:'WHAT (G League only): projected made threes per 36 minutes AGAINST NBA COMPETITION. PLAIN: what his line would look like as an NBA player at starter minutes. FORMULA: (per-game made threes / MPG) x 36 x level factor x pace factor. The level factor is the MEDIAN NBA-to-G-League ratio among 85 players who played 150+ minutes in both leagues this season; the pace factor is NBA median pace / G League median pace (101.8 / 103.8 = 0.981), because per-36 still contains possessions per minute and the two leagues do not play at the same speed.'},
  'p36.ts':{label:'TS% (own)',type:'pct',help:'WHAT: TS% in his own league. PLAIN: shooting efficiency as actually recorded. FORMULA: unchanged from the season line \u2014 rates do not scale with minutes.'},
  'p36n.ts':{label:'TS% NBA',type:'pct',help:'WHAT (G League only): projected TS% against NBA competition. PLAIN: how his shooting efficiency should hold up a level up. FORMULA: his own TS% PLUS the median DIFFERENCE observed among dual-league players (TS -5.8pts, 3P -2.3pts, eFG -3.0pts). A difference is used rather than a ratio because multiplying a percentage distorts badly near the tails.'},
  'p36.fg3Pct':{label:'3P% (own)',type:'pct',help:'WHAT: 3P% in his own league. PLAIN: shooting efficiency as actually recorded. FORMULA: unchanged from the season line \u2014 rates do not scale with minutes.'},
  'p36n.fg3Pct':{label:'3P% NBA',type:'pct',help:'WHAT (G League only): projected 3P% against NBA competition. PLAIN: how his shooting efficiency should hold up a level up. FORMULA: his own 3P% PLUS the median DIFFERENCE observed among dual-league players (TS -5.8pts, 3P -2.3pts, eFG -3.0pts). A difference is used rather than a ratio because multiplying a percentage distorts badly near the tails.'},
  'p36.efg':{label:'eFG% (own)',type:'pct',help:'WHAT: eFG% in his own league. PLAIN: shooting efficiency as actually recorded. FORMULA: unchanged from the season line \u2014 rates do not scale with minutes.'},
  'p36n.efg':{label:'eFG% NBA',type:'pct',help:'WHAT (G League only): projected eFG% against NBA competition. PLAIN: how his shooting efficiency should hold up a level up. FORMULA: his own eFG% PLUS the median DIFFERENCE observed among dual-league players (TS -5.8pts, 3P -2.3pts, eFG -3.0pts). A difference is used rather than a ratio because multiplying a percentage distorts badly near the tails.'},
  reliabilityWeight:{label:'Reliability',type:'1',help:'Weight this player’s own line carried in the shrinkage (max ~84)'},
  'tulip.leagueDelta':{label:'Role Value',type:'signed2',help:'WHAT: role-expansion VALUE (not a minutes recommendation, and not the same thing as Projected Role MPG) against a MEDIAN league rotation slot, at the player’s target minutes. PLAIN: how much the team would gain per 100 possessions by giving him a bigger role, compared with a typical rotation player rather than with his own weakest team-mate. FORMULA: projected on-court impact at the target minutes (from comparable players at that workload) MINUS the league-median rotation-slot impact. The league reference is used because the team-referenced version correlates -0.91 with whoever would be displaced and only +0.18 with the candidate, so it mostly measures the team-mate, not the player. Blank means TULIP abstained — too few comparables, or he already plays too many minutes for expansion to be a question. Blank is NOT zero and always sorts last.'},
  'tulip.neutralDelta':{label:'Role Value neutral',type:'signed2',help:'Same projection measured against a median team-mate rather than the weakest one. Displacing the weakest player flatters expansion by construction, so this is the fairer read.'},
  'tulip.projectedImpact':{label:'Role Value proj',type:'signed2',help:'Projected on-court impact at the target minutes, from comparable players'},
  'tulip.support':{label:'Role Value support',type:'int',help:'Evidence support score behind the projection (0-100)'},
  'tulip.tier':{label:'Evidence tier',type:'text',help:'Evidence tier A-D. D means the projection rests entirely on comparable players.'},
  'tulip.verdict':{label:'Role verdict',type:'text',help:'EXPAND ROLE / HOLD, from the rotation comparison'},
  'tulip.targetMpg':{label:'Role target MPG',type:'1',help:'Minutes level the projection was evaluated at'},
  pts:{label:'PTS',type:'1'}, reb:{label:'REB',type:'1'}, oreb:{label:'OREB',type:'1'}, dreb:{label:'DREB',type:'1'},
  ast:{label:'AST',type:'1'}, stl:{label:'STL',type:'1'}, blk:{label:'BLK',type:'1'}, blka:{label:'BLKA',type:'1'},
  tov:{label:'TOV',type:'1'}, pf:{label:'PF',type:'1'}, pfd:{label:'PFD',type:'1'},
  plusMinus:{label:'+/-',type:'signed1'}, dd2:{label:'DD',type:'int'}, td3:{label:'TD',type:'int'},
  fg:{label:'FG',type:'1'}, fga:{label:'FGA',type:'1'}, fgPct:{label:'FG%',type:'pct'},
  fg3:{label:'3P',type:'1'}, fg3a:{label:'3PA',type:'1'}, fg3Pct:{label:'3P%',type:'pct'},
  fg2:{label:'2P',type:'1'}, fg2a:{label:'2PA',type:'1'}, fg2Pct:{label:'2P%',type:'pct'},
  ft:{label:'FT',type:'1'}, fta:{label:'FTA',type:'1'}, ftPct:{label:'FT%',type:'pct'},
  efg:{label:'eFG%',type:'pct'}, ts:{label:'TS%',type:'pct'},
  fg3Ar:{label:'3PAr',type:'pct'}, ftr:{label:'FTr',type:'pct'}, astTo:{label:'AST/TO',type:'2'},
  usg:{label:'USG%',type:'pctPoints'}, astPct:{label:'AST%',type:'pctPoints'}, astRatio:{label:'AST Ratio',type:'1'},
  orebPct:{label:'OREB%',type:'pctPoints'}, drebPct:{label:'DREB%',type:'pctPoints'}, rebPct:{label:'REB%',type:'pctPoints'},
  toRatio:{label:'TO Ratio',type:'1'}, tovPct:{label:'TOV% (bref)',type:'pctPoints'},
  offRtg:{label:'OffRtg',type:'1',help:'Team points per 100 possessions while on court'},
  defRtg:{label:'DefRtg',type:'1',help:'Team points allowed per 100 possessions while on court'},
  netRtg:{label:'NetRtg',type:'signed1',help:'On-court team differential, not isolated individual value'},
  pace:{label:'Pace',type:'1'}, pie:{label:'PIE',type:'pct'}, poss:{label:'Poss',type:'int'},
  stlPer100:{label:'STL/100',type:'2'}, blkPer100:{label:'BLK/100',type:'2'},
  astPer100:{label:'AST/100',type:'2'}, tovPer100:{label:'TOV/100',type:'2'},
  defWs:{label:'DEF WS',type:'2'},
  per:{label:'PER',type:'2'}, ows:{label:'OWS',type:'2'}, dws:{label:'DWS',type:'2'}, ws:{label:'WS',type:'2'},
  ws48:{label:'WS/48',type:'3'}, obpm:{label:'OBPM',type:'2'}, dbpm:{label:'DBPM',type:'2'},
  bpm:{label:'BPM',type:'2'}, vorp:{label:'VORP',type:'2'},
  brefGP:{label:'BRef GP',type:'int',help:'Games the Basketball-Reference advanced line covers'},
  brefScope:{label:'BRef scope',type:'text'},
  stlPct:{label:'STL%',type:'pctPoints'}, blkPct:{label:'BLK%',type:'pctPoints'},
  wsPerGame:{label:'WS/G',type:'3'}, dwsPerGame:{label:'DWS/G',type:'3'}, vorpPerGame:{label:'VORP/G',type:'3'},
  'custom.selfCreatedPts36':{label:'Self-Created P36',type:'2'},
  'custom.situationalPts36':{label:'Situational P36',type:'2'},
  'custom.possessionSwing36':{label:'Poss Swing36',type:'signed2'},
  'custom.defensiveSwing36':{label:'Def Swing36',type:'2'},
  'custom.whistleDiff36':{label:'Whistle Diff36',type:'signed2'},
  'custom.disruptionPerFoul':{label:'Disrupt/Foul',type:'3'},
  'custom.creationLoad36':{label:'Creation Load36',type:'2'},
  'custom.paintPts36':{label:'Paint Pts36',type:'2'},
  'custom.efficiencyOverExpected':{label:'Eff Over Exp',type:'signed2'},
  'custom.impactOverExpected':{label:'Impact Over Exp',type:'signed2'},
  'custom.shotLocationValue':{label:'Shot Location',type:'1'},
  'custom.versatilityIndex':{label:'Versatility',type:'1'},
  'custom.twoWayIndex':{label:'Two-Way',type:'1'},
  'custom.selfSufficiencyIndex':{label:'Self-Sufficiency',type:'1'},
  'custom.defensiveDisruptionIndex':{label:'Def Disruption',type:'1'},
  'custom.selfCreatedPts36Raw':{label:'Self-Created P36 (raw)',type:'2'},
  'custom.situationalPts36Raw':{label:'Situational P36 (raw)',type:'2'},
  'custom.possessionSwing36Raw':{label:'Poss Swing36 (raw)',type:'signed2'},
  'custom.efficiencyOverExpectedRaw':{label:'Eff Over Exp (raw)',type:'signed2'},
  'custom.impactOverExpectedRaw':{label:'Impact Over Exp (raw)',type:'signed2'},
  'custom.paintPts36Raw':{label:'Paint Pts36 (raw)',type:'2'},
  'components.scoring':{label:'Scoring Comp',type:'1'}, 'components.playmaking':{label:'Playmaking Comp',type:'1'},
  'components.rebounding':{label:'Rebound Comp',type:'1'}, 'components.defense':{label:'Defense Comp',type:'1'},
  'components.efficiency':{label:'Efficiency Comp',type:'1'}, 'components.impact':{label:'Impact Comp',type:'1'},
  'stats.sit_home_gp':{label:'Home G',type:'int'},
  'stats.sit_home_mpg':{label:'Home MIN',type:'1'},
  'stats.sit_home_pts':{label:'Home PTS',type:'1'},
  'stats.sit_home_reb':{label:'Home REB',type:'1'},
  'stats.sit_home_ast':{label:'Home AST',type:'1'},
  'stats.sit_home_ts':{label:'Home TS%',type:'pct'},
  'stats.sit_home_plusminus':{label:'Home +/-',type:'signed1'},
  'stats.sit_road_gp':{label:'Road G',type:'int'},
  'stats.sit_road_mpg':{label:'Road MIN',type:'1'},
  'stats.sit_road_pts':{label:'Road PTS',type:'1'},
  'stats.sit_road_reb':{label:'Road REB',type:'1'},
  'stats.sit_road_ast':{label:'Road AST',type:'1'},
  'stats.sit_road_ts':{label:'Road TS%',type:'pct'},
  'stats.sit_road_plusminus':{label:'Road +/-',type:'signed1'},
  'stats.sit_wins_gp':{label:'In Wins G',type:'int'},
  'stats.sit_wins_mpg':{label:'In Wins MIN',type:'1'},
  'stats.sit_wins_pts':{label:'In Wins PTS',type:'1'},
  'stats.sit_wins_reb':{label:'In Wins REB',type:'1'},
  'stats.sit_wins_ast':{label:'In Wins AST',type:'1'},
  'stats.sit_wins_ts':{label:'In Wins TS%',type:'pct'},
  'stats.sit_wins_plusminus':{label:'In Wins +/-',type:'signed1'},
  'stats.sit_losses_gp':{label:'In Losses G',type:'int'},
  'stats.sit_losses_mpg':{label:'In Losses MIN',type:'1'},
  'stats.sit_losses_pts':{label:'In Losses PTS',type:'1'},
  'stats.sit_losses_reb':{label:'In Losses REB',type:'1'},
  'stats.sit_losses_ast':{label:'In Losses AST',type:'1'},
  'stats.sit_losses_ts':{label:'In Losses TS%',type:'pct'},
  'stats.sit_losses_plusminus':{label:'In Losses +/-',type:'signed1'},
  'stats.sit_starter_gp':{label:'Starting G',type:'int'},
  'stats.sit_starter_mpg':{label:'Starting MIN',type:'1'},
  'stats.sit_starter_pts':{label:'Starting PTS',type:'1'},
  'stats.sit_starter_reb':{label:'Starting REB',type:'1'},
  'stats.sit_starter_ast':{label:'Starting AST',type:'1'},
  'stats.sit_starter_ts':{label:'Starting TS%',type:'pct'},
  'stats.sit_starter_plusminus':{label:'Starting +/-',type:'signed1'},
  'stats.sit_bench_gp':{label:'Off Bench G',type:'int'},
  'stats.sit_bench_mpg':{label:'Off Bench MIN',type:'1'},
  'stats.sit_bench_pts':{label:'Off Bench PTS',type:'1'},
  'stats.sit_bench_reb':{label:'Off Bench REB',type:'1'},
  'stats.sit_bench_ast':{label:'Off Bench AST',type:'1'},
  'stats.sit_bench_ts':{label:'Off Bench TS%',type:'pct'},
  'stats.sit_bench_plusminus':{label:'Off Bench +/-',type:'signed1'},
  'stats.sit_preallstar_gp':{label:'Pre-ASB G',type:'int'},
  'stats.sit_preallstar_mpg':{label:'Pre-ASB MIN',type:'1'},
  'stats.sit_preallstar_pts':{label:'Pre-ASB PTS',type:'1'},
  'stats.sit_preallstar_reb':{label:'Pre-ASB REB',type:'1'},
  'stats.sit_preallstar_ast':{label:'Pre-ASB AST',type:'1'},
  'stats.sit_preallstar_ts':{label:'Pre-ASB TS%',type:'pct'},
  'stats.sit_preallstar_plusminus':{label:'Pre-ASB +/-',type:'signed1'},
  'stats.sit_postallstar_gp':{label:'Post-ASB G',type:'int'},
  'stats.sit_postallstar_mpg':{label:'Post-ASB MIN',type:'1'},
  'stats.sit_postallstar_pts':{label:'Post-ASB PTS',type:'1'},
  'stats.sit_postallstar_reb':{label:'Post-ASB REB',type:'1'},
  'stats.sit_postallstar_ast':{label:'Post-ASB AST',type:'1'},
  'stats.sit_postallstar_ts':{label:'Post-ASB TS%',type:'pct'},
  'stats.sit_postallstar_plusminus':{label:'Post-ASB +/-',type:'signed1'},
  'stats.sit_clutch_gp':{label:'Clutch G',type:'int'},
  'stats.sit_clutch_mpg':{label:'Clutch MIN',type:'1'},
  'stats.sit_clutch_pts':{label:'Clutch PTS',type:'1'},
  'stats.sit_clutch_reb':{label:'Clutch REB',type:'1'},
  'stats.sit_clutch_ast':{label:'Clutch AST',type:'1'},
  'stats.sit_clutch_ts':{label:'Clutch TS%',type:'pct'},
  'stats.sit_clutch_plusminus':{label:'Clutch +/-',type:'signed1'},
  'stats.sit_month1_gp':{label:'M1 G',type:'int',help:'Season month 1 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month1_pts':{label:'M1 PTS',type:'1',help:'Season month 1 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month1_ts':{label:'M1 TS%',type:'pct',help:'Season month 1 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month2_gp':{label:'M2 G',type:'int',help:'Season month 2 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month2_pts':{label:'M2 PTS',type:'1',help:'Season month 2 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month2_ts':{label:'M2 TS%',type:'pct',help:'Season month 2 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month3_gp':{label:'M3 G',type:'int',help:'Season month 3 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month3_pts':{label:'M3 PTS',type:'1',help:'Season month 3 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month3_ts':{label:'M3 TS%',type:'pct',help:'Season month 3 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month4_gp':{label:'M4 G',type:'int',help:'Season month 4 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month4_pts':{label:'M4 PTS',type:'1',help:'Season month 4 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month4_ts':{label:'M4 TS%',type:'pct',help:'Season month 4 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month5_gp':{label:'M5 G',type:'int',help:'Season month 5 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month5_pts':{label:'M5 PTS',type:'1',help:'Season month 5 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month5_ts':{label:'M5 TS%',type:'pct',help:'Season month 5 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month6_gp':{label:'M6 G',type:'int',help:'Season month 6 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month6_pts':{label:'M6 PTS',type:'1',help:'Season month 6 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month6_ts':{label:'M6 TS%',type:'pct',help:'Season month 6 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month7_gp':{label:'M7 G',type:'int',help:'Season month 7 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month7_pts':{label:'M7 PTS',type:'1',help:'Season month 7 \u2014 month 1 is the league opening month, not October'},
  'stats.sit_month7_ts':{label:'M7 TS%',type:'pct',help:'Season month 7 \u2014 month 1 is the league opening month, not October'},
  labScore:{label:'Lab Score',type:'1'}
};

const CUSTOM_KEYS = ['custom.selfCreatedPts36','custom.situationalPts36','custom.possessionSwing36',
  'custom.defensiveSwing36','custom.whistleDiff36','custom.disruptionPerFoul','custom.creationLoad36',
  'custom.paintPts36','custom.efficiencyOverExpected','custom.impactOverExpected',
  'custom.shotLocationValue','custom.versatilityIndex','custom.twoWayIndex',
  'custom.selfSufficiencyIndex','custom.defensiveDisruptionIndex'];

const TRACK_LABELS = {
  'stats.trk_drives_drives':'Drives','stats.trk_drives_drive_pts':'Drive Pts',
  'stats.trk_passing_passes_made':'Passes','stats.trk_passing_potential_ast':'Pot. AST',
  'stats.trk_passing_ast_points_created':'AST Pts Created','stats.trk_touches_touches':'Touches',
  'stats.trk_touches_time_of_poss':'Time of Poss','stats.trk_touches_paint_touches':'Paint Touches',
  'stats.trk_rebounding_reb_contest_pct':'Contested REB%','stats.trk_defense_def_rim_fg_pct':'Opp Rim FG%',
  'stats.hustle_contested_shots':'Contested','stats.hustle_deflections':'Deflections',
  'stats.hustle_charges_drawn':'Charges','stats.hustle_screen_assists':'Screen AST',
  'stats.hustle_loose_balls_recovered':'Loose Balls','stats.hustle_box_outs':'Box Outs',
  'stats.trk_catchshoot_catch_shoot_pts':'C&S Pts','stats.trk_catchshoot_catch_shoot_fga':'C&S FGA',
  'stats.trk_pullup_pull_up_pts':'Pull-Up Pts','stats.trk_pullup_pull_up_fga':'Pull-Up FGA',
};
for (const [k,label] of Object.entries(TRACK_LABELS)) BASE_COLS[k]={label,type:k.endsWith('_pct')?'pct':'1'};
for (const [k,label] of Object.entries({
  'stats.oscore_pct_pts_paint':'% Pts Paint','stats.oscore_pct_pts_3pt':'% Pts 3PT',
  'stats.oscore_pct_pts_2pt_mr':'% Pts Mid','stats.oscore_pct_pts_ft':'% Pts FT',
  'stats.oscore_pct_pts_fb':'% Pts FB','stats.oscore_pct_uast_fgm':'% FG Unast',
})) BASE_COLS[k]={label,type:'pct'};
for (const [k,label] of Object.entries({
  'stats.omisc_pts_paint':'Paint Pts','stats.omisc_pts_fb':'FB Pts',
  'stats.omisc_pts_off_tov':'Pts off TO','stats.omisc_pts_2nd_chance':'2nd Chance',
})) BASE_COLS[k]={label,type:'1'};
for (const [k,label] of Object.entries({
  'stats.split_reg_gp':'RS Games','stats.split_reg_min':'RS Min','stats.split_reg_pts':'RS Pts',
  'stats.split_showcase_gp':'Cup Games','stats.split_showcase_min':'Cup Min','stats.split_showcase_pts':'Cup Pts',
})) BASE_COLS[k]={label,type:'int'};

const PRESETS = {
  proj:['select','viewRank','name','proj.team','proj.status','proj.age','proj.gp','proj.mpg','proj.pts','proj.reb','proj.ast','proj.stl','proj.blk','proj.tov','proj.fg3m','proj.fgPct','proj.fg3Pct','proj.ftPct','proj.ts','proj.lastPts','proj.dPts'],
  overall:['select','viewRank','rank','name','team','position','age','gp','mpg','grade','rateGrade','magnitudeGrade','tb.tulip','tb.recommendedMpg','tb.confidence','tulip.leagueDelta','pts','reb','ast','stl','blk','ts','usg','pie','netRtg','custom.twoWayIndex','reliabilityWeight'],
  workload:['select','viewRank','name','team','position','age','gp','mpg','grade','tc.capacityMpg','tc.teamASeasonMpg','tc.headroom','tc.evidence','tulip.leagueDelta'],
  capacity:['select','viewRank','name','team','position','age','gp','tc.teamASeasonMpg','tc.capacityMpg','tc.headroom','tc.interval50Low','tc.interval50High','tc.evidence','grade'],
  tulipbeta:['select','viewRank','name','team','position','age','gp','tb.currentMpg','tb.tulip','tb.recommendedMpg','tb.confidence','tb.valueGapSd','tb.supportedCeiling','grade'],
  nbaready:['select','viewRank','name','team','position','age','gp','mpg','grade','nbaReadiness','rb.playmaking','rb.connecting','rb.defense','rb.hustle','rb.shooting'],
  per36:['select','viewRank','name','team','position','mpg','p36.pts','p36.reb','p36.ast','p36.stl','p36.blk','p36.tov','p36.fg3','p36.ts','p36.fg3Pct'],
  per36nba:['select','viewRank','name','team','position','mpg','p36n.pts','p36n.reb','p36n.ast','p36n.stl','p36n.blk','p36n.tov','p36n.fg3','p36n.ts','p36n.fg3Pct','nbaReadiness'],
  tulip:['select','viewRank','name','team','position','age','gp','mpg','grade','tulip.leagueDelta','tulip.neutralDelta','tulip.projectedImpact','tulip.targetMpg','tulip.support','tulip.tier','tulip.verdict'],
  scoring:['select','viewRank','name','team','grade','pts','fg','fga','fgPct','fg3','fg3a','fg3Pct','ft','fta','ftPct','efg','ts','fg3Ar','ftr','usg','custom.selfCreatedPts36','custom.paintPts36','custom.efficiencyOverExpected'],
  shooting:['select','viewRank','name','team','grade','fga','fgPct','fg3a','fg3Pct','fg2a','fg2Pct','ftPct','efg','ts','custom.efficiencyOverExpected','custom.shotLocationValue','stats.trk_catchshoot_catch_shoot_pts','stats.trk_catchshoot_catch_shoot_fga','stats.trk_pullup_pull_up_pts','stats.trk_pullup_pull_up_fga'],
  playmaking:['select','viewRank','name','team','grade','ast','tov','astPct','astRatio','astTo','astPer100','tovPer100','toRatio','usg','custom.creationLoad36','custom.selfSufficiencyIndex'],
  rebounding:['select','viewRank','name','team','grade','oreb','dreb','reb','orebPct','drebPct','rebPct','custom.possessionSwing36'],
  defense:['select','viewRank','name','team','grade','stl','blk','dreb','stlPer100','blkPer100','drebPct','defRtg','defWs','custom.defensiveDisruptionIndex','custom.defensiveSwing36','custom.disruptionPerFoul'],
  impact:['select','viewRank','name','team','grade','mpg','offRtg','defRtg','netRtg','pie','plusMinus','poss','pace','custom.impactOverExpected','custom.twoWayIndex','per','ws','ws48','bpm','vorp','brefGP','brefScope'],
  shotprofile:['select','viewRank','name','team','grade','pts','custom.shotLocationValue','custom.paintPts36','custom.situationalPts36','stats.oscore_pct_pts_paint','stats.oscore_pct_pts_3pt','stats.oscore_pct_pts_2pt_mr','stats.oscore_pct_pts_ft','stats.oscore_pct_pts_fb','stats.oscore_pct_uast_fgm','stats.omisc_pts_paint','stats.omisc_pts_fb','stats.omisc_pts_off_tov','stats.omisc_pts_2nd_chance'],
  custom:['select','viewRank','name','team','grade',...CUSTOM_KEYS,'labScore'],
  customraw:['select','viewRank','name','team','grade','gp','minutes','reliabilityWeight','custom.efficiencyOverExpected','custom.efficiencyOverExpectedRaw','custom.impactOverExpected','custom.impactOverExpectedRaw','custom.selfCreatedPts36','custom.selfCreatedPts36Raw','custom.situationalPts36','custom.situationalPts36Raw','custom.paintPts36','custom.paintPts36Raw'],
  components:['select','viewRank','name','team','grade','rateGrade','magnitudeGrade','magnitudeRaw','gradeCoverage','gradeRaw','gradeShrunk','reliabilityWeight','components.scoring','components.playmaking','components.rebounding','components.defense','components.efficiency','components.impact'],
  teams:['select','viewRank','name','team','teamCount','grade','gp','mpg','pts','reb','ast'],
  bio:['select','viewRank','name','team','position','positionFamily','positionSource','age','ageOpeningNight','ageFeb1','birthdate','height','weight','country','college','draftStatus','draftYear','draftRound','draftNumber','jersey','gp','grade'],
  splits:['select','viewRank','name','team','grade','gp','regularGP','showcaseGP','minutes','mpg','pts','reb','ast','brefGP','brefScope'],
  splitsExplorer:['select','viewRank','name','team','grade','gp','pts',
    'stats.sit_home_pts','stats.sit_road_pts','stats.sit_wins_pts','stats.sit_losses_pts',
    'stats.sit_starter_pts','stats.sit_bench_pts','stats.sit_preallstar_pts','stats.sit_postallstar_pts',
    'stats.sit_clutch_gp','stats.sit_clutch_pts','stats.sit_clutch_ts','stats.sit_clutch_plusminus'],
  splitsMonthly:['select','viewRank','name','team','grade','gp','pts',
    'stats.sit_month1_gp','stats.sit_month1_pts','stats.sit_month2_pts','stats.sit_month3_pts',
    'stats.sit_month4_pts','stats.sit_month5_pts','stats.sit_month6_pts','stats.sit_month7_pts'],
  splitsShooting:['select','viewRank','name','team','grade','ts',
    'stats.sit_home_ts','stats.sit_road_ts','stats.sit_wins_ts','stats.sit_losses_ts',
    'stats.sit_starter_ts','stats.sit_bench_ts','stats.sit_preallstar_ts','stats.sit_postallstar_ts'],
  tracking:['select','viewRank','name','team','grade','stats.trk_drives_drives','stats.trk_drives_drive_pts','stats.trk_passing_passes_made','stats.trk_passing_potential_ast','stats.trk_passing_ast_points_created','stats.trk_touches_touches','stats.trk_touches_time_of_poss','stats.trk_touches_paint_touches','stats.trk_rebounding_reb_contest_pct','stats.trk_defense_def_rim_fg_pct','stats.hustle_contested_shots','stats.hustle_deflections','stats.hustle_charges_drawn','stats.hustle_screen_assists','stats.hustle_loose_balls_recovered','stats.hustle_box_outs'],
};

/** Views that open on their own headline column rather than on grade. */
const PRESET_SORT = { tulipbeta:'tb.tulip', proj:'proj.pts', per36:'p36.pts', per36nba:'p36n.pts' };
const PRESET_LABELS = {overall:'Overall',proj:'2026-27 Projections',workload:'Projected Role MPG',capacity:'Projected Role MPG (detail)',tulipbeta:'TULIP Beta',tulip:'Role Value (expansion)',nbaready:'NBA Readiness (G League)',per36:'Per 36 Minutes',per36nba:'Per 36 — NBA Equivalent (G League)',scoring:'Scoring',shooting:'Shooting',playmaking:'Playmaking',
  rebounding:'Rebounding',defense:'Defense',impact:'Impact & Ratings',shotprofile:'Shot Profile',
  custom:'Custom Metrics',customraw:'Custom: adjusted vs raw',components:'Grade Components',
  splitsExplorer:'Splits: scoring',splitsShooting:'Splits: efficiency',splitsMonthly:'Splits: by month',
  teams:'Team History',bio:'Bio & Draft',splits:'Season Splits (G League)',
  tracking:'Tracking & Hustle (NBA)',all:'All Raw Stats'};

// CORE_REGISTRY removed in v3.5 — the field catalog and the records themselves are the registry.

function fmt(v,type){
  if (type==='text') return esc(v || '—');
  if (type==='int') return finite(v)?Math.round(Number(v)).toLocaleString():'—';
  if (type==='pct') return pct(v);
  if (type==='pctPoints') return pctPoints(v);
  if (type==='signed1') return signed(v,1);
  if (type==='signed2') return signed(v,2);
  if (type==='2') return num(v,2);
  if (type==='3') return num(v,3);
  if (type==='grade') return finite(v)?Number(v).toFixed(4):'—';
  if (type==='1') return num(v,1);
  if (!finite(v)) return esc(v ?? '—');
  const x=Number(v);
  return Math.abs(x)<1 && x!==0 ? x.toFixed(3) : x.toFixed(1);
}

/**
 * Filters and CSV export work in the unit the column header shows.
 * TS% is stored as 0.612 while USG% is stored as 31.2, so a raw ">= 60" silently matched
 * nothing on one and everything on the other. Everything labelled as a percentage is
 * converted to percentage points at the boundary.
 */
const isFraction = key => colDef(key).type === 'pct';
const toDisplayUnit = (key,v) => (finite(v) && isFraction(key) ? Number(v)*100 : v);
const fromDisplayUnit = (key,v) => (finite(v) && isFraction(key) ? Number(v)/100 : v);

function gradeClass(v){return v>=8.5?'elite':v>=6.5?'strong':v>=4?'mid':'low'}
function currentPlayers(){return DATA?.leagues?.[league] || []}

/** The current-roster view is NBA-only; G League has no equivalent published 2026-27 roster set. */
function isCurrentNbaRosterView(){ return league === 'NBA' && $('rosterScope')?.value === 'current'; }

function currentRosterCount(){ return currentPlayers().filter((p) => p.currentRoster).length; }

/**
 * Make the two valid contexts explicit: historical performance and the live roster snapshot.
 * This prevents a 2025-26 player without a current NBA spot from looking rostered, while keeping
 * his historical line available for research.
 */
function updateRosterScopeUi(){
  const nba = league === 'NBA';
  const scopeControl = $('rosterScopeControl');
  const scope = $('rosterScope');
  const rosterOnlyControl = $('rosterOnlyControl');
  const note = $('rosterScopeNote');
  if (!scopeControl || !scope || !note) return;

  scopeControl.hidden = !nba;
  if (!nba) {
    note.hidden = true;
    if (rosterOnlyControl) rosterOnlyControl.hidden = false;
    return;
  }

  const performanceCount = DATA?.counts?.NBA ?? currentPlayers().filter((p) => p.appeared).length;
  const rosterCount = currentRosterCount();
  scope.options[0].textContent = `2025-26 performance (${performanceCount.toLocaleString()})`;
  scope.options[1].textContent = `Current NBA rosters (${rosterCount.toLocaleString()})`;
  const current = isCurrentNbaRosterView();
  if (rosterOnlyControl) rosterOnlyControl.hidden = current;

  // The league-tab count describes the active, top-level data scope—not a narrowed search.
  $('nbaCount').textContent = (current ? rosterCount : performanceCount).toLocaleString();
  $('nbaCount').title = current
    ? `${rosterCount.toLocaleString()} players on the published current NBA roster snapshot`
    : `${performanceCount.toLocaleString()} players with a 2025-26 NBA appearance`;

  const asOf = longDate(DATA?.currentRosterMeta?.asOf);
  note.hidden = !current;
  if (current) {
    const withoutLine = currentPlayers().filter((p) => p.currentRoster && !p.appeared).length;
    note.innerHTML = `<b>Current NBA rosters:</b> ${rosterCount.toLocaleString()} players as of ${esc(asOf || 'the published snapshot')}, including ${withoutLine.toLocaleString()} players without a 2025-26 NBA appearance (such as rookies, new signings, or players who did not play). Their historical-stat cells are intentionally blank—not missing data.`;
  }
}

function rawMetricKeys(){
  const keys=new Set();
  for(const p of currentPlayers()) for(const [k,v] of Object.entries(p.stats||{})) if(finite(v)) keys.add(`stats.${k}`);
  return [...keys].sort();
}
/**
 * Single metric registry, derived from the data and the published field catalog rather than a
 * hand-maintained CORE_REGISTRY. A new field becomes available to the Formula Lab, numeric
 * filters and the column chooser the moment the build emits it — no separate registration.
 */
function metricRegistryKeys(){
  const sample=currentPlayers().slice(0,80);
  const present=new Set();
  const probe=(obj,prefix)=>{
    for(const p of sample) for(const k of Object.keys(p[obj]||{})) {
      const key=prefix+k;
      if(!present.has(key)&&sample.some(q=>finite(get(q,key)))) present.add(key);
    }
  };
  // Top-level numeric fields.
  for(const p of sample) for(const k of Object.keys(p)){
    if(['stats','custom','components','rateComponents','magnitudeComponents','teams','skillProfile',
        'archetypes','cohortRanks','gradeCoverageDetail','nbaTranslation','ownTeamFit','sourceIds'].includes(k)) continue;
    if(!present.has(k)&&sample.some(q=>finite(q[k]))) present.add(k);
  }
  probe('custom','custom.');
  probe('components','components.');
  probe('skillProfile','skill.');
  return [...present, ...rawMetricKeys()];
}
function allRawColumns(){
  const keys=new Set();
  for(const p of currentPlayers()) Object.keys(p.stats||{}).forEach(k=>keys.add(k));
  return ['select','viewRank','name','team','position','grade',...Array.from(keys).sort().map(k=>`stats.${k}`),'reliabilityWeight'];
}
function visibleColumns(){
  const preset=$('viewPreset').value;
  let cols=preset==='all'?allRawColumns():[...(PRESETS[preset]||PRESETS.overall)];
  if(preset!=='all'){
    const players=currentPlayers();
    cols=cols.filter(k=>{
      if(!k.startsWith('stats.')&&!['gs','per','ws','ws48','bpm','vorp','regularGP','showcaseGP','brefGP','brefScope','seasonAge','tovPct','stlPct','blkPct'].includes(k)) return true;
      return players.some(p=>finite(get(p,k))||(colDef(k).type==='text'&&get(p,k)));
    });
  }
  if(labConfig.length && !cols.includes('labScore')) cols.push('labScore');
  return cols;
}
/**
 * Column definition, with hover text resolved from the documentation the build already produces
 * rather than hand-copied here. Hand-written duplicates of 1,820 catalog entries would drift the
 * moment a source field changed; this stays in sync by construction.
 * Priority: explicit BASE_COLS help > metricDefinitions (derived metrics) > fieldCatalog (raw
 * source fields, including provenance and units).
 */
const COLUMN_HELP = {"name": "WHAT: player name. PLAIN: who this is. Click it to open the full player card.", "team": "WHAT: team abbreviation. PLAIN: for NBA rows this is the current 2026-27 roster team; for G League it remains the 2025-26 team until new rosters are published. Historical 2025-26 team/stint identity is preserved separately and is never overwritten.", "position": "WHAT: listed position. PLAIN: where he plays. FORMULA: taken from the official roster listing, not inferred from play style.", "positionFamily": "WHAT: grouped position (guard / wing / big). PLAIN: broad role bucket. FORMULA: collapsed from the listed position.", "positionSource": "WHAT: where the position label came from. PLAIN: which source we trust for this row. FORMULA: provenance string, not a statistic.", "gp": "WHAT: games played. PLAIN: how many games he appeared in. FORMULA: count of games with any playing time.", "regularGP": "WHAT: regular-season games played. PLAIN: games excluding the G League Showcase Cup. FORMULA: count of Regular Season games only.", "showcaseGP": "WHAT: Showcase Cup games played (G League). PLAIN: games in the Tip-Off tournament. FORMULA: count of Showcase games only. The G League season splits into Showcase and Regular Season; neither alone is a full season.", "mpg": "WHAT: minutes per game. PLAIN: how much he plays. FORMULA: total minutes / games played.", "minutes": "WHAT: total minutes. PLAIN: season workload. FORMULA: sum of minutes across all games.", "pts": "WHAT: points per game. PLAIN: scoring. FORMULA: total points / games played.", "reb": "WHAT: rebounds per game. FORMULA: (offensive + defensive rebounds) / games played.", "oreb": "WHAT: offensive rebounds per game. FORMULA: total offensive rebounds / games played.", "dreb": "WHAT: defensive rebounds per game. FORMULA: total defensive rebounds / games played.", "ast": "WHAT: assists per game. FORMULA: total assists / games played.", "stl": "WHAT: steals per game. FORMULA: total steals / games played.", "blk": "WHAT: blocks per game. FORMULA: total blocks / games played.", "tov": "WHAT: turnovers per game. PLAIN: lower is better. FORMULA: total turnovers / games played.", "plusMinus": "WHAT: plus/minus per game. PLAIN: team point differential while he is on the floor. FORMULA: (team points - opponent points) while on court, per game. A TEAM result, not an individual one.", "fg": "WHAT: field goals made per game. FORMULA: total made field goals / games played.", "fga": "WHAT: field goals attempted per game. FORMULA: total attempts / games played.", "fgPct": "WHAT: field goal percentage. PLAIN: shots made out of shots taken. FORMULA: FGM / FGA. Treats a three the same as a layup, which is why eFG% and TS% exist.", "fg2a": "WHAT: two-point attempts per game. FORMULA: (FGA - 3PA) / games played.", "fg2Pct": "WHAT: two-point percentage. FORMULA: 2PM / 2PA.", "fg3": "WHAT: threes made per game. FORMULA: total made threes / games played.", "fg3a": "WHAT: three-point attempts per game. FORMULA: total 3PA / games played.", "fg3Pct": "WHAT: three-point percentage. FORMULA: 3PM / 3PA.", "fg3Ar": "WHAT: three-point attempt rate. PLAIN: what share of his shots are threes. FORMULA: 3PA / FGA.", "ft": "WHAT: free throws made per game. FORMULA: total FTM / games played.", "fta": "WHAT: free throws attempted per game. FORMULA: total FTA / games played.", "ftPct": "WHAT: free throw percentage. FORMULA: FTM / FTA.", "ftr": "WHAT: free throw rate. PLAIN: how often he gets to the line relative to shooting. FORMULA: FTA / FGA.", "efg": "WHAT: effective field goal percentage. PLAIN: shooting percentage that credits a three as worth more. FORMULA: (FGM + 0.5 x 3PM) / FGA.", "ts": "WHAT: true shooting percentage. PLAIN: the best single measure of scoring efficiency \\u2014 counts twos, threes and free throws together. FORMULA: PTS / (2 x (FGA + 0.44 x FTA)).", "usg": "WHAT: usage rate. PLAIN: share of team possessions he finishes while on the floor. FORMULA: estimated possessions used (shots, turnovers, trips to the line) as a percent of team possessions used while on court.", "astPct": "WHAT: assist rate. PLAIN: share of team-mate baskets he assists while on court. FORMULA: AST / (estimated team-mate field goals made while on court).", "astRatio": "WHAT: assist ratio. PLAIN: how much of what he does ends in an assist. FORMULA: AST per 100 possessions he uses.", "astTo": "WHAT: assist-to-turnover ratio. PLAIN: passes that help versus passes that cost. FORMULA: AST / TOV.", "astPer100": "WHAT: assists per 100 possessions. PLAIN: pace-neutral playmaking volume. FORMULA: AST x 100 / possessions.", "toRatio": "WHAT: turnover ratio. PLAIN: turnovers per 100 possessions used. FORMULA: TOV x 100 / possessions used. NOTE: this is NOT the same statistic as team TOV%.", "tovPer100": "WHAT: turnovers per 100 possessions. FORMULA: TOV x 100 / possessions.", "stlPer100": "WHAT: steals per 100 possessions. PLAIN: pace-neutral steal volume. FORMULA: STL x 100 / possessions.", "blkPer100": "WHAT: blocks per 100 possessions. FORMULA: BLK x 100 / possessions.", "orebPct": "WHAT: offensive rebound rate. FORMULA: share of available offensive rebounds he collects while on court.", "drebPct": "WHAT: defensive rebound rate. FORMULA: share of available defensive rebounds he collects while on court.", "rebPct": "WHAT: total rebound rate. FORMULA: share of all available rebounds he collects while on court.", "pace": "WHAT: pace. PLAIN: possessions per 48 minutes for his team while he plays. FORMULA: estimated team possessions per 48. A TEAM context number, not a skill.", "poss": "WHAT: possessions. PLAIN: how many possessions he was on the floor for. FORMULA: estimated possessions played.", "pie": "WHAT: Player Impact Estimate. PLAIN: his share of everything that happened in his games. FORMULA: his box-score contributions as a percent of both teams\\u2019 combined contributions.", "per": "WHAT: Player Efficiency Rating (Basketball-Reference). PLAIN: per-minute box-score productivity, league-average 15. NOTE: a snapshot from Basketball-Reference, not re-fetched with the rest of the database.", "ws": "WHAT: win shares. PLAIN: estimated wins credited to him. FORMULA: offensive + defensive win shares (Basketball-Reference).", "ws48": "WHAT: win shares per 48 minutes. PLAIN: rate version of win shares. FORMULA: WS / minutes x 48.", "defWs": "WHAT: defensive win shares. FORMULA: Basketball-Reference defensive win share estimate.", "bpm": "WHAT: box plus/minus. PLAIN: estimated points per 100 possessions above league average. FORMULA: Basketball-Reference regression on box-score stats.", "vorp": "WHAT: value over replacement player. FORMULA: (BPM - (-2.0)) x share of minutes played x team games / 82 (Basketball-Reference).", "grade": "WHAT: overall per-game grade, 0.0000-9.9999. PLAIN: single-number rating of season performance. FORMULA: six weighted percentile components (scoring .30, playmaking .18, rebounding .14, defense .16, efficiency .12, impact .10), shrunk toward the league mean in proportion to minutes played, then mapped onto the 0-9.9999 scale.", "gradeRaw": "WHAT: grade before shrinkage. PLAIN: what his own line alone says, with no regression to the mean. FORMULA: the weighted component score prior to the minutes-based shrinkage step.", "gradeShrunk": "WHAT: grade after shrinkage, before scaling. FORMULA: (minutes x own score + K x league prior) / (minutes + K), with K = 0.8 x median minutes.", "labScore": "WHAT: your custom Formula Lab score. PLAIN: whatever combination of metrics you built in the Lab. FORMULA: defined by your own metric weights, not by this app.", "height": "WHAT: listed height.", "weight": "WHAT: listed weight in pounds.", "jersey": "WHAT: jersey number.", "college": "WHAT: college or last team before turning pro.", "country": "WHAT: country of origin.", "birthdate": "WHAT: date of birth. Used to compute the exact age columns.", "teamCount": "WHAT: number of teams he played for this season. PLAIN: 2+ means he was traded or moved between teams.", "draftYear": "WHAT: year he was drafted.", "draftRound": "WHAT: draft round.", "draftNumber": "WHAT: overall draft pick number.", "draftStatus": "WHAT: drafted or undrafted, with the pick if drafted.", "brefScope": "WHAT: which Basketball-Reference rows this player\\u2019s snapshot covers. PLAIN: provenance for the BR-sourced columns (PER, win shares, BPM, VORP).", "components.scoring": "WHAT: scoring component of the grade (30% weight). FORMULA: weighted percentile of points, true shooting and shot creation within the league.", "components.playmaking": "WHAT: playmaking component (18% weight). FORMULA: weighted percentile of assists, assist rate and ball security.", "components.rebounding": "WHAT: rebounding component (14% weight). FORMULA: weighted percentile of offensive and defensive rebound rates.", "components.defense": "WHAT: defense component (16% weight). FORMULA: weighted percentile of steals, blocks, defensive rating and defensive rebounding.", "components.efficiency": "WHAT: efficiency component (12% weight). FORMULA: weighted percentile of true shooting and turnover economy.", "components.impact": "WHAT: impact component (10% weight). FORMULA: weighted percentile of on-court results such as PIE and net rating.", "custom.twoWayIndex": "WHAT: two-way index. PLAIN: a single number for being good at both ends. FORMULA: equal blend of offensive percentiles (offensive rating, true shooting, scoring) and defensive percentiles (defensive rating, defensive win shares per 36, steals+blocks, defensive rebound rate), averaged 50/50. PIE is deliberately excluded because it already contains defensive rebounds, steals and blocks, which made defence count on both sides.", "custom.efficiencyOverExpectedRaw": "WHAT: efficiency over expected, BEFORE shrinkage. PLAIN: the unregressed version, noisier on small samples. FORMULA: same as the adjusted column without the minutes-weighted shrinkage step.", "custom.impactOverExpectedRaw": "WHAT: impact over expected, BEFORE shrinkage. FORMULA: unregressed version of the adjusted column.", "custom.paintPts36Raw": "WHAT: paint points per 36, BEFORE shrinkage. FORMULA: unregressed version of the adjusted column.", "custom.selfCreatedPts36Raw": "WHAT: self-created points per 36, BEFORE shrinkage. FORMULA: unregressed version of the adjusted column.", "custom.situationalPts36Raw": "WHAT: situational points per 36, BEFORE shrinkage. FORMULA: unregressed version of the adjusted column."};

// Keep the published glossary synchronized with the real grade ingredients rather than the older
// prose that predated the current model.
Object.assign(COLUMN_HELP, {
  team: 'WHAT: current NBA roster status. PLAIN: an NBA abbreviation means the player is on that current roster; No NBA roster means the published snapshot has no current NBA team for him. The 2025-26 performance team is shown separately beside a player when it differs. G League rows remain their 2025-26 team until new G League rosters are published.',
  'components.scoring': 'WHAT: scoring component of the grade (30% weight). FORMULA: weighted percentile of points, free-throw attempts, three-point attempts and usage within the league.',
  'components.defense': 'WHAT: defense component (16% weight). FORMULA: weighted percentile of steals, blocks, defensive rating and defensive win shares.',
  'components.efficiency': 'WHAT: efficiency component (12% weight). FORMULA: weighted percentile of true shooting, effective field-goal percentage, turnovers and turnover percentage.',
});


/** Split a help string into its WHAT / PLAIN / FORMULA sections for structured display. */
function parseHelp(text){
  const t = String(text || '').trim();
  if (!t) return null;
  const out = {};
  const grab = (label, next) => {
    const re = new RegExp(label + ':\\s*([\\s\\S]*?)(?=' + (next.length ? '(?:' + next.join(':|') + ':)' : '$') + '|$)', 'i');
    const m = t.match(re);
    return m ? m[1].trim().replace(/\s+$/, '') : null;
  };
  out.what = grab('WHAT', ['PLAIN', 'FORMULA', 'NOTE']);
  out.plain = grab('PLAIN', ['FORMULA', 'NOTE']);
  out.formula = grab('FORMULA', ['NOTE']);
  out.note = grab('NOTE', []);
  // Text that predates the WHAT/PLAIN/FORMULA convention (catalog-derived entries) is shown whole.
  if (!out.what && !out.plain && !out.formula) out.what = t;
  return out;
}

let tipEl = null, tipPinned = false, tipAnchor = null;
function statTip(){
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.id = 'statTip';
  document.body.appendChild(tipEl);
  return tipEl;
}
function showStatTip(th, key){
  const d = colDef(key);
  const h = parseHelp(d.help);
  if (!h) return;
  const el = statTip();
  const sec = (k, v, cls) => v ? `<div class="tip-sec ${cls||''}"><span class="tip-k">${k}</span><span class="tip-v">${esc(v)}</span></div>` : '';
  el.innerHTML = `<div class="tip-name">${esc(d.label || key)}</div>`
    + sec('What it is', h.what)
    + sec('In plain words', h.plain)
    + sec('How it is calculated', h.formula, 'tip-formula')
    + sec('Note', h.note)
    + `<div class="tip-hint">${isTouch ? 'Tap a header to sort \u00b7 tap anywhere to close' : 'Click a header to sort \u00b7 Esc or click anywhere to close'}</div>`
    + '<button type="button" class="tip-close" aria-label="Close explanation">Close</button>';
  // Always interactive so the close control works on any device, and always closable.
  el.classList.add('pinned');
  const host = th.closest('dialog[open]') || document.body;
  if (el.parentNode !== host) host.appendChild(el);
  const cb = el.querySelector('.tip-close');
  if (cb) cb.onclick = () => hideStatTip(true);
  tipAnchor = th;
  el.classList.add('show');
  placeStatTip(th.getBoundingClientRect());
}

/**
 * Column headers: ONE click sorts; PRESS AND HOLD opens the explanation. Nothing happens on hover.
 * Hover previews opened a large panel every time the pointer crossed the header row, and on touch
 * the same tap both sorted and opened it. Holding is deliberate, works identically with a mouse,
 * a trackpad and a finger, and the click that ends a hold is swallowed so it never also sorts.
 * Keyboard: Enter or Space sorts, "?" explains.
 */
const HOLD_MS=450;
function wireHeader(th, key, onSort){
  let timer=null, held=false, start=null;
  const cancel=()=>{ clearTimeout(timer); timer=null; start=null; th.classList.remove('pressing'); };
  th.addEventListener('pointerdown',(e)=>{
    if(e.button!==0) return;
    held=false; start={x:e.clientX,y:e.clientY};
    th.classList.add('pressing');
    timer=setTimeout(()=>{ timer=null; held=true; th.classList.remove('pressing'); showStatTip(th, key); }, HOLD_MS);
  });
  // A drag or scroll is not a hold.
  th.addEventListener('pointermove',(e)=>{ if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>8) cancel(); });
  th.addEventListener('pointerup',cancel);
  th.addEventListener('pointercancel',cancel);
  th.addEventListener('pointerleave',cancel);
  // Long-press on touch would otherwise open the system menu or start a text selection.
  th.addEventListener('contextmenu',(e)=>{ if(held||timer) e.preventDefault(); });
  th.addEventListener('click',(e)=>{
    if(held){ held=false; e.preventDefault(); e.stopPropagation(); return; }
    hideStatTip(true); onSort();
  });
  th.addEventListener('keydown',(e)=>{
    if(e.key==='?'||(e.key==='/'&&e.shiftKey)){ e.preventDefault(); showStatTip(th, key); return; }
    if(e.key!=='Enter'&&e.key!==' ') return;
    e.preventDefault(); hideStatTip(true); onSort();
  });
}

/** Keep the panel beside its header and fully inside the viewport. */
function placeStatTip(r){
  const el = statTip();
  const w = el.offsetWidth, hgt = el.offsetHeight;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8));
  let top = r.bottom + 8;
  if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 8);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}
function hideStatTip(force){ if (tipEl && (force || !tipPinned)) { tipPinned = false; tipAnchor = null; tipEl.classList.remove('show'); } }

// Touch devices have no hover: a tap fires mouseenter but never mouseleave, so the panel stayed up
// and — being pointer-events:none — could not even be tapped away. It covered the table with no way
// out. On coarse pointers the panel therefore gets an explicit close control, and every route that
// should dismiss it is wired below.
// Kept only to decide the hint wording. Behaviour no longer branches on it, because headless
// Chromium reports (pointer: coarse) as true and that silently disabled the panel on desktop.
const isTouch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideStatTip(true); });
  // Any tap or click that is not on a header dismisses it.
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest && (e.target.closest('#statTip') || e.target.closest('th[data-sort],th[data-ta-col]'))) return;
    hideStatTip(true);
  }, true);
  // Scrolling RE-ANCHORS the panel to its header rather than dismissing it. Blanket-hiding on
  // scroll looked right but raced with the browser scrolling a header into view in order to hover
  // it: the panel opened and was killed by the very scroll that revealed it. If the header has
  // left the viewport there is nothing to explain, so it closes.
  window.addEventListener('scroll', () => {
    if (!tipEl || !tipEl.classList.contains('show') || !tipAnchor) return;
    const r = tipAnchor.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight || !tipAnchor.isConnected) { hideStatTip(true); return; }
    placeStatTip(r);
  }, true);
  window.addEventListener('resize', () => hideStatTip(true));
  document.addEventListener('close', () => hideStatTip(true), true);   // a closing dialog takes its header with it
}

/**
 * Full browsable reference for every column the app can show.
 *
 * ONE dialog instance, reused. An earlier version built a fresh <dialog> per open, which gave every
 * copy the same element ids — so document.getElementById('sgClose') resolved to the FIRST, already
 * closed, dialog. The live one never closed and never removed itself, leaking a dialog per open
 * (observed climbing 6 -> 7 -> 8 -> 9 with four orphans left in the DOM). Queries are also scoped
 * to the dialog now rather than going through document.
 */
let statGuideDlg = null;
function openStatGuide(){
  const seen = new Map();
  for (const keys of Object.values(PRESETS)) for (const k of keys) {
    if (k === 'select' || seen.has(k)) continue;
    const d = colDef(k);
    if (d && d.help) seen.set(k, d);
  }
  const items = [...seen.entries()].sort((a,b)=>String(a[1].label).localeCompare(String(b[1].label)));
  // Search still exposes every documented metric; a compact starting set prevents the dialog
  // from dumping hundreds of definitions before a reader has asked for one.
  const featured = new Set(['grade','rateGrade','reliabilityWeight','pts','ts','usg','astPct','drebPct','defRtg','components.scoring','components.defense','proj.pts','tb.tulip','tulip.leagueDelta']);
  const render = (filter) => {
    const matched = items.filter(([k,d]) => !filter || (d.label+' '+k+' '+d.help).toLowerCase().includes(filter));
    const visible = filter ? matched : matched.filter(([k]) => featured.has(k)).slice(0, 14);
    return visible.map(([k,d]) => {
      const h = parseHelp(d.help);
      const sec = (lab, v, cls) => v ? `<div class="sg-sec"><span class="sg-k">${lab}</span>${cls?`<span class="${cls}">${esc(v)}</span>`:esc(v)}</div>` : '';
      return `<details class="stat-guide-item"><summary><span>${esc(d.label||k)}<span class="sg-key">${esc(k)}</span></span></summary><div class="sg-body">`
        + sec('What it is', h.what) + sec('In plain words', h.plain)
        + sec('How it is calculated', h.formula, 'sg-formula') + sec('Note', h.note) + '</div></details>';
    }).join('') || '<p>No stat matches that search.</p>';
  };

  if (!statGuideDlg) {
    statGuideDlg = document.createElement('dialog');
    statGuideDlg.className = 'modal wide';
    statGuideDlg.innerHTML = `<div class="modal-sticky-head"><div><h2>Stat guide</h2>
      <p class="sg-count"></p></div><button class="modal-x" type="button" data-sg="close" aria-label="Close stat guide">×</button></div>
      <input class="stat-guide-search" data-sg="search" type="search" aria-label="Search stats" placeholder="Search stats, e.g. TULIP, true shooting, readiness\u2026" />
      <div class="stat-guide-list" data-sg="list"></div>
      <div class="modal-actions"><button class="button" data-sg="close">Close</button></div>`;
    document.body.appendChild(statGuideDlg);
    statGuideDlg.querySelector('[data-sg="search"]').addEventListener('input', (e) => {
      statGuideDlg.querySelector('[data-sg="list"]').innerHTML = render(e.target.value.trim().toLowerCase());
    });
    statGuideDlg.querySelectorAll('[data-sg="close"]').forEach((b) => { b.onclick = () => statGuideDlg.close(); });
  }
  statGuideDlg.querySelector('.sg-count').textContent =
    `Start with the essentials below or search all ${items.length} documented stats.`;
  statGuideDlg.querySelector('[data-sg="search"]').value = '';
  statGuideDlg.querySelector('[data-sg="list"]').innerHTML = render('');
  statGuideDlg.showModal();
}

function colDef(key){
  const base = BASE_COLS[key] || {label:humanize(key), type:''};
  if (base.help) return base;
  const rawHelp = COLUMN_HELP[key] || docHelp(key);
  const help = typeof rawHelp === 'string' ? rawHelp.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))) : rawHelp;
  return help ? {...base, help} : base;
}

function docHelp(key){
  const md = DATA?.metricDefinitions || {};
  const short = key.includes('.') ? key.slice(key.indexOf('.')+1) : key;
  const def = md[key] || md[short];
  if (def) return typeof def === 'string' ? def : (def.definition || def.description || null);
  const cat = DATA?.fieldCatalog || {};
  // The catalog is keyed "LEAGUE:field"; try the active league first, then either.
  const entry = cat[`${league}:${key}`] || cat[`NBA:${key}`] || cat[`GLEAGUE:${key}`];
  if (!entry) return null;
  const bits = [];
  if (entry.label) bits.push(entry.label);
  if (entry.unit) bits.push(`Unit: ${entry.unit}`);
  if (entry.basis) bits.push(`Basis: ${entry.basis}`);
  if (entry.seasonScope) bits.push(`Scope: ${entry.seasonScope}`);
  if (entry.direction) bits.push(`Direction: ${entry.direction}`);
  if (entry.sourceDetail) bits.push(`Source: ${entry.sourceDetail}`);
  else if (entry.source) bits.push(`Source: ${entry.source}`);
  return bits.length ? bits.join(' \u00b7 ') : null;
}

/** Catalog entry for a field: source, unit, basis, season scope, direction. */
function meta(key){
  if(!DATA?.fieldCatalog) return null;
  if(key.startsWith('stats.')) return DATA.fieldCatalog[`${league}:${key}`]||null;
  return DATA.fieldCatalog._topLevel?.[key]||null;
}
function scopeOf(key){
  const m=meta(key);
  if(m?.seasonScope) return m.seasonScope;
  if(key.startsWith('stats.bref_')||['per','ows','dws','ws','ws48','obpm','dbpm','bpm','vorp','tovPct','stlPct','blkPct'].includes(key))
    return league==='GLEAGUE'?'regular-season-only':'full-season';
  if(key.startsWith('stats.split_showcase_')) return 'showcase-only';
  if(key.startsWith('stats.split_reg_')) return 'regular-season-only';
  if(key.startsWith('stats.sit_')) return 'situational-split';
  return league==='GLEAGUE'?'regular-season-plus-showcase':'full-season';
}

function populateSelectors(){
  const players=currentPlayers();
  const fill=(id,label,vals)=>{
    const cur=$(id).value;
    $(id).innerHTML=`<option value="">${label}</option>`+vals.map(x=>`<option>${esc(x)}</option>`).join('');
    if(vals.includes(cur))$(id).value=cur;
  };
  const teamValues = league === 'NBA'
    ? players.map((p) => p.currentTeam).filter(Boolean)
    : players.map((p) => p.team).filter(Boolean);
  fill('teamFilter', league === 'NBA' ? 'All current teams' : 'All teams',[...new Set(teamValues)].sort());
  if ($('teamMode')) {
    $('teamMode').options[0].textContent = league === 'NBA'
      ? 'Current roster — show 2025-26 season totals'
      : 'Played for team, season totals';
    $('teamMode').options[1].textContent = league === 'NBA'
      ? '2025-26 stint with selected team (if applicable)'
      : 'Stats with this team only';
  }
  fill('positionFilter','All positions',[...new Set(players.map(p=>p.positionFamily).filter(Boolean))].sort());
  fill('countryFilter','All countries',[...new Set(players.map(p=>p.country).filter(Boolean))].sort());
  const hasSplits=players.some(p=>p.showcaseGP>0);
  const hasTracking=players.some(p=>p.stats&&p.stats.trk_drives_drives!==undefined);
  const hasMonths=players.some(p=>p.stats&&Object.keys(p.stats).some(k=>/^sit_month\d+_gp$/.test(k)));
  // Projected Role MPG is validated for NBA offseason acquisitions only, so the dedicated view is
  // offered only where at least one player actually has a supported prediction.
  const hasCapacity=players.some(p=>p.tulipCapacity&&p.tulipCapacity.abstain!==true);
  const hasBeta=players.some(p=>p.tulipBeta&&p.tulipBeta.abstain!==true);
  const hasProj=players.some(p=>p.proj&&p.proj.abstain!==true);
  const current=$('viewPreset').value;
  $('viewPreset').innerHTML=Object.entries(PRESET_LABELS).filter(([k])=>
    (k!=='splits'||hasSplits)&&(k!=='tracking'||hasTracking)&&(k!=='splitsMonthly'||hasMonths)&&(!['capacity','workload'].includes(k)||hasCapacity)&&(!['nbaready','per36nba'].includes(k)||league==='GLEAGUE')&&(k!=='tulipbeta'||hasBeta)&&(k!=='proj'||hasProj)
  ).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('');
  // Keep the chosen view across a league switch when the other league offers it too.
  if([...$('viewPreset').options].some(o=>o.value===current)) $('viewPreset').value=current;
}

function applyRules(p){
  return rules.every(r=>{
    const raw=get(p,r.key); if(!finite(raw))return false;
    const v=toDisplayUnit(r.key,Number(raw)),t=Number(r.value);
    return r.op==='>='?v>=t:r.op==='<='?v<=t:r.op==='>'?v>t:v<t;
  });
}

/** A hyphenated family such as G-F satisfies a filter for either of its parts. */
function positionMatches(p,fam){
  if(!fam) return true;
  const f=p.positionFamily;
  if(!f) return false;
  return f===fam||f.split('-').includes(fam);
}

/** NBA team filtering is current-roster filtering; G League remains season-team filtering. */
function playedFor(p,team){
  if(!team) return true;
  if(p.league==='NBA') return p.currentTeam===team;
  if(p.team===team) return true;
  return (p.teams||[]).some(s=>s.team===team);
}

/**
 * With a team selected and "stats with this team only" chosen, a multi-team player is shown on
 * his STINT line rather than his season aggregate. Showing full-season numbers under a team
 * label is the quietly wrong answer: Harden's Cleveland row would include his Clipper games.
 */
/**
 * Fields the stint line actually provides. Anything NOT listed here has no stint equivalent —
 * the source publishes advanced and tracking data per season, not per stint — so in team-only
 * mode those are BLANKED rather than left showing season values. A row that mixed Cleveland-only
 * points with full-season TS% was the worst outcome, because nothing on screen said so.
 */
const STINT_FIELDS = {gp:'gp',minutes:'min',mpg:'mpg',pts:'pts',reb:'reb',ast:'ast',
  stl:'stl',blk:'blk',fgPct:'fgPct',fg3Pct:'fg3Pct',ftPct:'ftPct',plusMinus:'plusMinus'};
/** Season-only fields that must not be shown beside stint numbers. */
// TULIP is computed once on the full-season line, so a per-team stint row must not display it as
// though it were computed for that stint.
const SEASON_ONLY = ['grade','rateGrade','gradeRaw','gradeShrunk','reliabilityWeight','rank',
  'tulip.leagueDelta','tulip.neutralDelta','tulip.projectedImpact','tulip.support','tulip.tier',
  'tulip.verdict','tulip.targetMpg','opt.minutesDelta',
  'nbaReadiness','rb.playmaking','rb.connecting','rb.defense',
  'rb.hustle','rb.shooting',
  'ts','efg','usg','astPct','astRatio','orebPct','drebPct','rebPct','toRatio','tovPct',
  'offRtg','defRtg','netRtg','pace','pie','poss','stlPer100','blkPer100','astPer100','tovPer100',
  'defWs','per','ows','dws','ws','ws48','obpm','dbpm','bpm','vorp','stlPct','blkPct',
  'wsPerGame','dwsPerGame','vorpPerGame','oreb','dreb','fg','fga','fg3','fg3a','fg2','fg2a',
  'ft','fta','tov','pf','pfd','blka','dd2','td3','fg2Pct','fg3Ar','ftr','astTo',
  'wins','losses','regularGP','showcaseGP','teamCount'];

function teamScoped(p,team,mode){
  if(!team||mode!=='only') return p;
  const stint=(p.teams||[]).find(s=>s.team===team);
  // Joining a team this offseason does not create a 2025-26 stint there.
  if(!stint) return p.league==='NBA' ? {...p,currentRosterFilteredTo:team} : p;
  const q={...p, team:stint.team, teamScopedTo:team, seasonGp:p.gp, seasonGrade:p.grade};
  for(const [dest,src] of Object.entries(STINT_FIELDS)) q[dest]=stint[src];
  for(const k of SEASON_ONLY) q[k]=null;
  q.custom={}; q.components={}; q.rateComponents={};
  // Raw source fields are season-scoped with no stint equivalent.
  q.stats={};
  // Nested objects are season scoped too; never retain them on a stint line.
  q.per36={};
  for(const k of ['pts','reb','ast','stl','blk']) {
    q.per36[k]=finite(q[k])&&q.mpg>0?Number(q[k])*36/q.mpg:null;
  }
  q.per36.fg3Pct=q.fg3Pct;
  q.per36Nba=null; q.tulip=null; q.tulipBeta=null; q.tulipCapacity=null;
  q.optimal=null; q.proj=null; q.magnitudeGrade=null; q.magnitudeRaw=null;
  return q;
}

/**
 * Ordinal labels sort by what they mean, not alphabetically. Sorting Support alphabetically put
 * MEDIUM above HIGH; High-to-low must read HIGH, MEDIUM, LOW.
 */
const ORDINAL={'tb.confidence':{HIGH:3,MEDIUM:2,LOW:1},'tulip.tier':{A:4,B:3,C:2,D:1}};
function sortValue(p,key){
  const v=get(p,key);
  const scale=ORDINAL[key];
  if(scale) return v===null||v===undefined?null:(scale[String(v).toUpperCase()]??null);
  return v;
}

function filteredPlayers(){
  const q=fold($('searchInput').value.trim());
  const team=$('teamFilter').value, pos=$('positionFilter').value, country=$('countryFilter').value;
  const minGp=Number($('minGp').value)||0, minMpg=Number($('minMpg').value)||0;
  const minMin=Number($('minMin').value)||0, minGrade=Number($('minGrade').value)||0;
  const minRel=Number($('minReliability').value)||0;
  const teamMode=$('teamMode')?.value||'season';
  const showRosterOnly=$('includeRosterOnly')?.checked;
  const currentRosterView=isCurrentNbaRosterView();
  let list=currentPlayers()
    .filter(p=>{
      const hay=fold([p.name,p.currentTeam,p.seasonTeam,p.team,p.position,p.country,p.college,...(p.teams||[]).map(s=>s.team)].filter(Boolean).join(' '));
      // A direct search should find a rookie or new signing even in the historical-stat view;
      // browsing them all belongs in the explicit Current NBA rosters view.
      const directRosterSearch=Boolean(q)&&hay.includes(q);
      if(currentRosterView && !p.currentRoster) return false;
      if(!currentRosterView && p.rosterOnly&&!showRosterOnly&&!directRosterSearch) return false;
      return (!q||hay.includes(q))&&playedFor(p,team)&&(!pos||positionMatches(p,pos))&&(!country||p.country===country)
        &&(!$('bothOnly').checked||p.bothLeagues);
    })
    // Scope BEFORE the numeric filters, so thresholds apply to the line actually displayed.
    .map(p=>teamScoped(p,team,teamMode))
    .filter(p=>{
      const gradeOk=p.grade===null?(showRosterOnly||currentRosterView||Boolean(q)||p.teamScopedTo):p.grade>=minGrade;
      return p.gp>=minGp&&(p.mpg||0)>=minMpg&&(p.minutes||0)>=minMin&&gradeOk
        &&(p.teamScopedTo||(p.reliabilityWeight||0)>=minRel)&&applyRules(p);
    });
  list.sort((a,b)=>{
    const av=sortValue(a,sortKey),bv=sortValue(b,sortKey);
    if(finite(av)&&finite(bv))return (Number(av)-Number(bv))*sortDir;
    if(finite(av))return -1;if(finite(bv))return 1;
    // Blank is not a value: it sorts last in both directions, for text columns too.
    const ab=av===null||av==='', bb=bv===null||bv==='';
    if(ab||bb) return ab===bb?0:ab?1:-1;
    return String(av).localeCompare(String(bv))*sortDir;
  });
  return list;
}

/**
 * Keep the "Sort by" / "Order" dropdowns and the clickable column headers showing the same state.
 * The dropdown lists the columns currently on screen, so every option sorts something the user can
 * actually see, and sorting the full database no longer requires discovering that headers are
 * clickable and scrolling sideways to find the column.
 */
function syncSortControls(cols){
  const sel=$('sortField'); if(!sel) return;
  const sortable=cols.filter(k=>k!=='select'&&k!=='viewRank');
  const sig=sortable.join('|');
  if(sel.dataset.sig!==sig){
    sel.dataset.sig=sig;
    sel.innerHTML=sortable.map(k=>`<option value="${esc(k)}">${esc(colDef(k).label)}</option>`).join('');
  }
  // If the active sort column is not in this view (e.g. after switching preset), fall back to the
  // first sortable column rather than showing a selection that does not exist.
  if(!sortable.includes(sortKey)){
    const own=PRESET_SORT[$('viewPreset').value];
    sortKey = own&&sortable.includes(own) ? own : sortable.includes('grade') ? 'grade' : sortable[0];
  }
  sel.value=sortKey;
  const ord=$('sortOrder'); if(ord) ord.value=String(sortDir);
}

function renderRules(){
  $('activeRules').innerHTML=rules.map((r,i)=>`<div class="rule-chip">${esc(colDef(r.key).label)} ${esc(r.op)} ${esc(r.value)}${isFraction(r.key)?'%':''} <button type="button" data-rule-remove="${i}" aria-label="Remove ${esc(colDef(r.key).label)} filter">×</button></div>`).join('');
  document.querySelectorAll('[data-rule-remove]').forEach(b=>b.onclick=()=>{rules.splice(Number(b.dataset.ruleRemove),1);render();writeUrlState('push');});
}

/** Title, breadcrumb and section highlight follow the league and the view. */
function updatePageHead(){
  const preset=$('viewPreset').value, lg=league==='NBA'?'NBA':'G League', isProj=preset==='proj', currentRosterView=isCurrentNbaRosterView();
  $('pageTitle').textContent=isProj?`2026-27 ${lg} Projections`:currentRosterView?'2026-27 NBA Current Rosters':`2025-26 ${lg} Player Stats`;
  $('crumbs').textContent=isProj
    ? `${lg} › 2026-27 › Projections`
    : currentRosterView ? 'NBA › 2026-27 › Current rosters'
      : `${lg} › 2025-26 › ${PRESET_LABELS[preset]||'Player stats'}`;
  document.querySelectorAll('.site-link[data-goto]').forEach(b=>b.classList.toggle('active',(b.dataset.goto==='proj')===isProj));
  $('projNote').hidden=!isProj;
  if(DATA?.projectionMeta?.rostersAsOf) $('projRosterDate').textContent=longDate(DATA.projectionMeta.rostersAsOf);
  const scope=$('projScope');
  if(scope) scope.textContent=league==='NBA'
    ? 'uses his 2026-27 team’s roster and pace'
    : 'uses the player’s G League assignment and G League pace context, not an NBA-affiliate forecast';
  $('seasonEyebrow').textContent=league==='NBA'?'Regular season':'Regular season and Showcase Cup combined';
}

/** Top navigation: player stats, or the 2026-27 projections view of the same table. */
function goTo(dest){
  if(dest==='comps'){
    if(window.__wsSetMode) window.__wsSetMode('similarity', false);
    writeUrlState('push');
    window.scrollTo({top:0});
    return;
  }
  if(window.__wsSetMode) window.__wsSetMode('database', false);
  const sel=$('viewPreset');
  if(dest==='proj'){
    if(![...sel.options].some(o=>o.value==='proj')) return;
    sel.value='proj'; sortKey='proj.pts'; sortDir=-1;
  } else if(sel.value==='proj'){
    sel.value='overall'; sortKey='grade'; sortDir=-1;
  }
  render();
  writeUrlState('push');
  window.scrollTo({top:0});
}

function render(){
  updateRosterScopeUi();
  updatePageHead();
  const cols=visibleColumns();
  // Resolve a preset's fallback sort before sorting rows or deriving displayed ranks.
  syncSortControls(cols);
  const list=filteredPlayers();
  let limit=Number($('rowLimit').value)||50;
  viewRankOf=new Map(list.map((p,i)=>[p.playerId,i+1]));
  // A wide view times the row count gives the real cost. All Raw Stats at 1,075 columns x 582
  // rows is 625,000 cells and took 6.1s to lay out, so very wide views cap their rows and say so.
  const CELL_BUDGET=30000;
  let capped=0;
  if(cols.length*Math.min(limit,list.length)>CELL_BUDGET){
    const maxRows=Math.max(10,Math.floor(CELL_BUDGET/cols.length));
    if(maxRows<Math.min(limit,list.length)){ capped=maxRows; limit=maxRows; }
  }
  const shown=list.slice(0,limit);
  $('resultCount').textContent=list.length.toLocaleString();
  $('rowCapNote').textContent=capped
    ? `Showing ${capped} rows — ${cols.length} columns x more rows exceeds the render budget. Narrow the view or filter to see others.`
    : '';
  const scoped=shown.filter(p=>p.teamScopedTo).length;
  $('sortLabel').textContent=`· ${isCurrentNbaRosterView()?'current-roster view':'2025-26 performance'} · sorted by ${colDef(sortKey).label} ${sortDir<0?'↓':'↑'}`
    +(scoped?` · ${scoped} multi-team ${scoped===1?'player is':'players are'} showing ${$('teamFilter').value}-only stint lines`:'');
  hideStatTip(true);   // a re-render replaces the header the panel was anchored to
  $('tableHead').innerHTML=cols.map(key=>{
    const d=colDef(key);
    const hasTip = !!d.help;
    // tabindex + role make the header a real control: it can be reached by keyboard, which is
    // also what makes the focus-triggered explainer panel reachable without a mouse. aria-sort
    // announces the current ordering to screen readers.
    if(key==='viewRank') return '<th scope="col" aria-label="Display row number; not sortable">#</th>';
    const aria = sortKey===key ? (sortDir<0?'descending':'ascending') : 'none';
    const label=key==='team'&&league==='NBA'?(isCurrentNbaRosterView()?'Current team':'Current status'):d.label;
    return `<th class="${key==='name'?'left':''}${hasTip?' has-tip':''}" data-sort="${esc(key)}" tabindex="0" role="columnheader" aria-sort="${aria}">${esc(label)}${sortKey===key?(sortDir<0?' ↓':' ↑'):''}</th>`;
  }).join('');
  $('tableBody').innerHTML=shown.map(p=>`<tr>${cols.map(key=>cell(p,key)).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="loading">No players match these filters.</td></tr>`;
  document.querySelectorAll('#tableHead [data-sort]').forEach(th=>wireHeader(th, th.dataset.sort, ()=>{
    const k=th.dataset.sort;if(sortKey===k)sortDir*=-1;else{sortKey=k;sortDir=-1}render();writeUrlState('push');
  }));
  document.querySelectorAll('[data-player]').forEach(b=>b.onclick=()=>openPlayer(b.dataset.player));
  document.querySelectorAll('[data-profile]').forEach(b=>b.onclick=()=>window.__wsOpenPlayer?.(b.dataset.profile));
  document.querySelectorAll('[data-compare]').forEach(c=>c.onchange=()=>{if(c.checked){if(compared.size>=5){c.checked=false;return}compared.add(c.dataset.compare)}else compared.delete(c.dataset.compare);updateCompare();});
  renderRules(); updateCompare();
}

function cell(p,key){
  const def=colDef(key),v=get(p,key);
  if(key==='select')return `<td><input class="compare-check" type="checkbox" data-compare="${esc(p.playerId)}" aria-label="Compare ${esc(p.name)}" ${compared.has(p.playerId)?'checked':''}></td>`;
  if(key==='name'){
    const multi=(p.teamCount||1)>1?`<span class="multi-badge" aria-label="${esc((p.teams||[]).map(s=>`${s.team} ${s.gp}g`).join(' · '))}">${p.teamCount} TM</span>`:'';
    // In the projections view the Team column is the 2026-27 team, so the name cell leaves last
    // season's team out rather than show two different teams on one row.
    let sub;
    if($('viewPreset').value==='proj') sub=esc(p.position||'—');
    else if(p.league==='NBA'){
      sub=esc(p.currentTeam||'No NBA roster')+' · '+esc(p.position||'—');
      if(p.currentRoster&&!p.appeared) sub+=' · Current roster, no 2025-26 NBA stats';
      if(p.seasonTeam&&p.seasonTeam!==p.currentTeam) sub+=' · 2025-26: '+esc(p.seasonTeam);
    } else sub=esc(p.team||'')+' · '+esc(p.position||'—');
    return `<td class="left player-cell"><button class="player-link" data-player="${esc(p.playerId)}">${esc(p.name)}</button>${window.__wsOpenPlayer?`<button class="profile-link" data-profile="${esc(p.playerId)}" aria-label="Open full profile">↗</button>`:''}${p.bothLeagues?'<span class="both-badge">NBA ↔ G</span>':''}${multi}<span class="tiny">${sub}</span></td>`;
  }
  if(key==='grade')return `<td class="grade ${gradeClass(v)}">${fmt(v,def.type)}</td>`;
  if(key==='team'&&p.league==='NBA'){
    const cls=p.currentTeam?'': 'status-unsigned';
    return `<td class="${cls}">${fmt(v,def.type)}</td>`;
  }
  if(key==='proj.status'){
    const cls=p.proj?.status==='new'?'status-new':p.proj?.status==='unsigned'?'status-unsigned':'';
    return `<td class="${cls}">${fmt(v,def.type)}</td>`;
  }
  // Direction is the point of a TULIP value or a projected change, so it reads at a glance.
  if(key==='tb.tulip'||key==='tb.valueGapSd'||key==='proj.dPts'){
    const cls=finite(v)&&Number(v)>0?'metric-good':finite(v)&&Number(v)<0?'metric-bad':'';
    return `<td class="${cls}">${fmt(v,def.type)}</td>`;
  }
  return `<td class="${key==='viewRank'||key==='rank'?'rank':''}">${fmt(v,def.type)}</td>`;
}

function updateCompare(){
  $('compareCount').textContent=compared.size;
  $('compareBtn').disabled=compared.size<2;
}

function counterpart(p){
  const other=league==='NBA'?'GLEAGUE':'NBA';
  return (DATA.leagues[other]||[]).find(x=>x.nbaPersonId===p.nbaPersonId)||null;
}

/** The row as currently displayed, including any team scoping — not the raw season record. */
function displayedRow(id){
  return filteredPlayers().find(x=>x.playerId===id)
      || currentPlayers().find(x=>x.playerId===id) || null;
}

function roleEvidencePlain(tier,factor){
  const tierLevel=({A:0,B:1,C:2,D:2})[tier]??3;
  const f=Number(factor);
  const factorLevel=!Number.isFinite(f)?3:f>=.85?0:f>=.60?1:f>=.35?2:3;
  return ['Strong support','Moderate support','Limited support','Very limited support'][Math.max(tierLevel,factorLevel)];
}

function valueSignalPlain(v){
  const x=Number(v)||0, a=Math.abs(x);
  const strength=a>=1.5?'Very strong':a>=0.75?'Strong':a>=0.25?'Moderate':a>0?'Slight':'Neutral';
  return a===0?'Neutral':`${strength} ${x>0?'positive':'negative'}`;
}

function tulipConstraintPath(c){
  const minutesPerSd=Number(DATA?.tulipBetaMeta?.config?.minutesPerSd)||10.0;
  const raw=finite(c.rawSignalDelta)?c.rawSignalDelta:(Number(c.valueGapSd)||0)*minutesPerSd;
  const constrained=finite(c.constrainedDelta)?c.constrainedDelta:c.tulip;
  const constraintNote=raw>0?'role evidence attenuation + 40 MPG feasibility applied':raw<0?'0 MPG floor applied':'constraints reviewed';
  return `<div class="tulip-constraint-path" aria-label="TULIP constraint path">
    <div class="tulip-constraint-step"><span>Raw signal</span><b>${signed(raw)} MPG</b>
      <small>team-relative value</small></div>
    <span class="tulip-constraint-arrow" aria-hidden="true">&rarr;</span>
    <div class="tulip-constraint-step"><span>Evidence/feasibility adjusted</span><b>${signed(constrained)} MPG</b>
      <small>${constraintNote}</small></div>
    <span class="tulip-constraint-arrow" aria-hidden="true">&rarr;</span>
    <div class="tulip-constraint-step"><span>Roster-balanced final TULIP</span><b>${signed(c.tulip)} MPG</b>
      <small>team ledger conserved</small></div>
  </div>`;
}

function whyTulipBlock(p,c){
  const signal=valueSignalPlain(c.valueGapSd);
  const team=p.league==='NBA'?(p.currentTeam||p.team):p.team;
  const expansion=(finite(c.rawSignalDelta)?Number(c.rawSignalDelta):Number(c.valueGapSd))>0;
  const supportedGap=Number(c.recommendedMpg)-Number(c.supportedCeiling);
  const workload=expansion
    ? supportedGap>0.05
      ? `${num(c.currentMpg)} MPG; direct workload/role evidence extends to ${num(c.supportedCeiling)} MPG, so the recommendation extrapolates ${num(supportedGap)} MPG beyond that evidence.`
      : `${num(c.currentMpg)} MPG, with the recommendation staying inside the directly supported workload range up to ${num(c.supportedCeiling)} MPG.`
    : `${num(c.currentMpg)} MPG. The 0 MPG feasibility floor limits how many minutes can be returned to the roster.`;
  const roleLine=expansion
    ? `<p><b>Role Evidence:</b> ${roleEvidencePlain(c.evidenceTier,c.evidenceFactor)} (Tier ${esc(c.evidenceTier||'—')} · factor ${num(c.evidenceFactor,2)}). This factor controls how much proposed positive expansion survives; it is not a probability of correctness.</p>`
    : '';
  const roster=c.tulip>0
    ? `${signed(c.tulip)} MPG must be surrendered elsewhere on ${esc(team)}.`
    : c.tulip<0
      ? `${signed(Math.abs(c.tulip))} MPG becomes available to higher-ranked team-mates on ${esc(team)}.`
      : `The roster-balanced result is no displayed change on ${esc(team)}.`;
  return `<section class="tulip-why tulip-explanation" aria-label="Why this TULIP">
    <h3>Why TULIP recommends ${signed(c.tulip)} MPG</h3>
    <div class="tulip-why-list">
      <p><b>Team-relative value:</b> ${esc(signal)} — ${signed(c.valueGapSd,2)} SD versus ${esc(team)}'s average allocated minute.</p>
      <p><b>Baseline workload:</b> ${workload}</p>
      ${roleLine}
      <p><b>Roster effect:</b> ${roster}</p>
      <p><b>Final:</b> ${num(c.currentMpg)} &rarr; ${num(c.recommendedMpg)} MPG.</p>
    </div>
    ${tulipConstraintPath(c)}
  </section>`;
}


/* ---------------------------------------------------------- TULIP TEAM VIEW */
// TULIP is a ZERO-SUM roster allocation. Read player-by-player it looks like six independent
// "play him more" claims; read as a team ledger it is obvious that every added minute is taken from
// a team-mate. This view exists so the conservation is visible rather than implied.
let teamAllocDlg = null;
const teamAllocState={team:null,filter:'all',sort:'tulip'};
const teamAllocationHeader=(title)=>`<div class="modal-sticky-head"><h2>${title}</h2><button class="modal-x" type="button" data-ta-close aria-label="Close TULIP team allocation">×</button></div>`;
function teamAllocationSort(roster,key){
  const support={HIGH:3,MEDIUM:2,LOW:1};
  const val=(p)=>key==='current'?p.tulipBeta.currentMpg
    :key==='recommended'?p.tulipBeta.recommendedMpg
    :key==='support'?(support[p.tulipBeta.confidence]||0):p.tulipBeta.tulip;
  return roster.slice().sort((a,b)=>(val(b)-val(a))||a.name.localeCompare(b.name));
}
function teamAllocationDirection(p){
  return p.tulipBeta.tulip>0?'gaining':p.tulipBeta.tulip<0?'losing':'nochange';
}
function openTeamAllocation(team,{preserveState=false}={}){
  if(!teamAllocDlg){
    teamAllocDlg=document.createElement('dialog');
    teamAllocDlg.id='teamAllocationDialog';
    teamAllocDlg.className='modal wide';
    document.body.appendChild(teamAllocDlg);
    teamAllocDlg.addEventListener('click',e=>{ if(e.target.dataset && e.target.dataset.taClose!==undefined) teamAllocDlg.close(); });
  }
  const all=[].concat(...Object.values(DATA.leagues||{}));
  const teams=[...new Set(all.filter(p=>p.league==='NBA'&&p.currentTeam&&p.tulipBeta&&!p.tulipBeta.abstain).map(p=>p.currentTeam))].sort();
  if(!team){
    teamAllocState.team=null;
    teamAllocDlg.innerHTML=`${teamAllocationHeader('TULIP Team Allocation')}
      <p class="tiny">Pick a current 2026-27 NBA roster to see its reallocation ledger. TULIP Beta is NBA-only.</p>
      <div class="raw-grid">${teams.map(t=>`<button class="button" data-teamalloc="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <div class="modal-actions"><button class="button" data-ta-close>Close</button></div>`;
    if(!teamAllocDlg.open) teamAllocDlg.showModal();
    return;
  }
  if(!preserveState||teamAllocState.team!==team){
    teamAllocState.team=team;
    teamAllocState.filter='all';
    teamAllocState.sort='tulip';
  }
  const baseRoster=all.filter(p=>p.league==='NBA'&&p.currentTeam===team&&p.tulipBeta&&!p.tulipBeta.abstain);
  const roster=teamAllocationSort(baseRoster,teamAllocState.sort);
  if(!roster.length){
    teamAllocDlg.innerHTML=`${teamAllocationHeader(`TULIP Team Allocation — ${esc(team)}`)}
      <p class="tiny">No eligible players with a TULIP Beta recommendation for this team.</p>
      <div class="modal-actions"><button class="button" data-ta-close>Close</button></div>`;
    if(!teamAllocDlg.open) teamAllocDlg.showModal();
    return;
  }
  const curTot=baseRoster.reduce((a,p)=>a+p.tulipBeta.currentMpg,0);
  const diag=DATA.tulipBetaMeta&&DATA.tulipBetaMeta.teamDiagnostics?DATA.tulipBetaMeta.teamDiagnostics[team]:null;
  const recTot=baseRoster.reduce((a,p)=>a+p.tulipBeta.recommendedMpg,0);
  const net=recTot-curTot;
  const gained=baseRoster.filter(p=>p.tulipBeta.tulip>0).sort((a,b)=>b.tulipBeta.tulip-a.tulipBeta.tulip);
  const surrendered=baseRoster.filter(p=>p.tulipBeta.tulip<0).slice().sort((a,b)=>a.tulipBeta.tulip-b.tulipBeta.tulip);
  const gTot=gained.reduce((a,p)=>a+p.tulipBeta.tulip,0);
  const sTot=surrendered.reduce((a,p)=>a+p.tulipBeta.tulip,0);
  const visible=roster.filter(p=>teamAllocState.filter==='all'||teamAllocationDirection(p)===teamAllocState.filter);
  const li=(p)=>`<div class="raw-row"><span>${esc(p.name)}</span><b>${signed(p.tulipBeta.tulip)}</b></div>`;
  const ev=(p)=>{const c=p.tulipBeta;
    const expansion=(finite(c.rawSignalDelta)?Number(c.rawSignalDelta):Number(c.valueGapSd))>0;
    if(!expansion) return '<span class="role-evidence-label">Not applied to reductions</span><span class="tiny">Expansion constraint only</span>';
    return c.evidenceTier
      ? `<span class="role-evidence-label">${esc(roleEvidencePlain(c.evidenceTier,c.evidenceFactor))}</span><span class="tiny">Tier ${esc(c.evidenceTier)} · factor ${num(c.evidenceFactor,2)}</span>`:'—';};
  const filterButton=(value,label)=>`<button class="button secondary small" type="button" data-ta-filter="${value}"
    aria-pressed="${teamAllocState.filter===value}">${label}</button>`;
  teamAllocDlg.innerHTML=`${teamAllocationHeader(`TULIP Team Allocation — ${esc(team)}`)}
    <div class="player-grid">
      <div class="detail-card"><div class="k">Baseline eligible MPG</div><div class="v">${num(curTot)}</div></div>
      <div class="detail-card"><div class="k">Recommended eligible MPG</div><div class="v">${num(recTot)}</div></div>
      <div class="detail-card"><div class="k">Net reallocation</div><div class="v">${signed(net)}</div></div>
      <div class="detail-card"><div class="k">Eligible players</div><div class="v">${baseRoster.length}</div></div>
    </div>
    <p class="tiny">TULIP Beta reallocates a team's existing player-minute workload toward players
    favored by its team-relative performance and role evidence. Positive values gain minutes;
    negative values surrender minutes. The roster ledger is conserved. TULIP Beta is experimental and
    neither its play-more/play-less direction nor its exact MPG magnitude has been validated as win-maximizing. Net reallocation is
    0.0 apart from per-player rounding to one decimal. <b>This is a workload redistribution heuristic, not a playable 240-minute rotation.</b>
    The sum combines historical individual workloads. <b>Availability is not verified</b>, positional/lineup constraints are not enforced, and excluded current-roster players may exist when TULIP abstains.</p>
    ${diag?`<p class="tiny"><b>Roster coverage:</b> ${diag.scoredPlayers}/${diag.currentRosterPlayers} current-roster players scored; ${diag.abstainedPlayers} excluded current-roster players. This is a conserved eligible-player workload ledger, not a complete 240-minute rotation.</p>`:''}
    <div class="crossover">
      <div class="eyebrow">MINUTES GAINED &nbsp;(${signed(gTot)})</div>
      <div class="raw-grid">${gained.length?gained.map(li).join(''):'<div class="raw-row"><span>none</span><b>0.0</b></div>'}</div>
    </div>
    <div class="crossover">
      <div class="eyebrow">MINUTES SURRENDERED &nbsp;(${signed(sTot)})</div>
      <div class="raw-grid">${surrendered.length?surrendered.map(li).join(''):'<div class="raw-row"><span>none</span><b>0.0</b></div>'}</div>
    </div>
    <p class="tiny">The two totals balance: every minute gained is funded by a minute surrendered on
    this roster. The allocator moves only what can actually be sourced, so it does not produce a
    unique one-to-one transfer between named players — the ledger is roster-level.</p>
    <div class="team-allocation-controls">
      <div class="team-allocation-filters" role="group" aria-label="Filter allocation table">
        ${filterButton('all',`All (${baseRoster.length})`)}
        ${filterButton('gaining',`Gaining (${gained.length})`)}
        ${filterButton('losing',`Losing (${surrendered.length})`)}
        ${filterButton('nochange',`No change (${baseRoster.length-gained.length-surrendered.length})`)}
      </div>
      <label>Sort allocation table
        <select data-ta-sort aria-label="Sort allocation table">
          <option value="tulip" ${teamAllocState.sort==='tulip'?'selected':''}>TULIP</option>
          <option value="current" ${teamAllocState.sort==='current'?'selected':''}>Baseline MPG</option>
          <option value="recommended" ${teamAllocState.sort==='recommended'?'selected':''}>Recommended MPG</option>
          <option value="support" ${teamAllocState.sort==='support'?'selected':''}>Support</option>
        </select>
      </label>
    </div>
    <div class="table-wrap"><table class="compare-table"><thead><tr>
      <th class="left">Player</th>${[['current','tb.currentMpg','Baseline MPG'],['tulip','tb.tulip','TULIP'],['recommended','tb.recommendedMpg','Recommended MPG'],['support','tb.confidence','Support']]
        .map(([k,help,label])=>`<th class="sortable" tabindex="0" data-ta-col="${k}" data-help="${help}" aria-sort="${teamAllocState.sort===k?'descending':'none'}">${label}${teamAllocState.sort===k?' ↓':''}</th>`).join('')}<th>Role evidence</th></tr></thead>
      <tbody data-ta-roster-body>${visible.map(p=>`<tr data-ta-direction="${teamAllocationDirection(p)}">
        <td class="left"><button class="player-link" data-player="${esc(p.playerId)}">${esc(p.name)}</button></td>
        <td>${num(p.tulipBeta.currentMpg)}</td>
        <td class="${p.tulipBeta.tulip>0?'metric-good':p.tulipBeta.tulip<0?'metric-bad':''}"><b>${signed(p.tulipBeta.tulip)}</b></td>
        <td>${num(p.tulipBeta.recommendedMpg)}</td>
        <td>${esc(p.tulipBeta.confidence||'—')}</td>
        <td>${ev(p)}</td></tr>`).join('')||'<tr><td colspan="6" class="tiny">No players match this filter.</td></tr>'}</tbody></table></div>
    <p class="tiny">Support is the strength of the data and evidence behind each recommendation's
    inputs, not a probability that the recommendation is correct. Role evidence shows the evidence
    tier and the attenuation factor applied to any expansion.</p>
    <div class="modal-actions">
      <button class="button" data-teamalloc="">Another team</button>
      <button class="button" data-ta-close>Close</button></div>`;
  // Same header contract as the main table: click sorts, press and hold explains.
  teamAllocDlg.querySelectorAll('[data-ta-col]').forEach(th=>wireHeader(th, th.dataset.help, ()=>{
    teamAllocState.sort=th.dataset.taCol; openTeamAllocation(team,{preserveState:true});
  }));
  if(!teamAllocDlg.open) teamAllocDlg.showModal();
}
// Delegated so dynamically rendered buttons (player detail, team picker, table rows) all work.
document.addEventListener('DOMContentLoaded',()=>{
  const btn=document.getElementById('tulipAllocBtn');
  if(btn) btn.addEventListener('click',()=>{
    const t=($('teamFilter')&&$('teamFilter').value)||'';
    openTeamAllocation(t&&t!=='All teams'?t:null);
  });
});
document.addEventListener('click',e=>{
  const f=e.target.closest && e.target.closest('[data-ta-filter]');
  if(f&&teamAllocState.team){ e.preventDefault(); teamAllocState.filter=f.dataset.taFilter; openTeamAllocation(teamAllocState.team,{preserveState:true}); return; }
  const b=e.target.closest && e.target.closest('[data-teamalloc]');
  if(b){ e.preventDefault(); openTeamAllocation(b.dataset.teamalloc||null); return; }
  const pl=e.target.closest && e.target.closest('[data-player]');
  if(pl && teamAllocDlg && teamAllocDlg.open){ teamAllocDlg.close(); openPlayer(pl.dataset.player); }
});
document.addEventListener('change',e=>{
  const s=e.target.closest && e.target.closest('[data-ta-sort]');
  if(s&&teamAllocState.team){ teamAllocState.sort=s.value; openTeamAllocation(teamAllocState.team,{preserveState:true}); }
});

/* ------------------------------------------------------------------ 2026-27 PROJECTION */
const longDate = (iso) => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
const pctChange = (x, d=1) => finite(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—';

/** The player-card section: last season beside the projection, and how the projection was built. */
function projCard(p){
  const c=p.proj;
  if(!c) return '';
  if(c.abstain) return `<div class="proj-card"><div class="section-bar">2026-27 projection</div>
    <p class="tiny" style="margin:8px 10px">${esc(c.reason)} A zero would be a false claim, so none is shown.</p></div>`;
  const w=c.why||{}, games=p.league==='NBA'?82:50;
  const row=(label,last,proj,d=1)=>`<tr><td class="left">${label}</td><td>${num(last,d)}</td><td><b>${num(proj,d)}</b></td></tr>`;
  const prow=(label,last,proj)=>`<tr><td class="left">${label}</td><td>${pct(last)}</td><td><b>${pct(proj)}</b></td></tr>`;
  const table=`<table class="compare-table"><thead><tr><th class="left">Per game</th><th>2025-26</th><th>2026-27 estimate</th></tr></thead><tbody>
    ${row('Games',p.gp,c.gp,0)}${row('Minutes',p.mpg,c.mpg)}${row('Points',p.pts,c.pts)}
    ${row('Rebounds',p.reb,c.reb)}${row('Assists',p.ast,c.ast)}${row('Steals',p.stl,c.stl)}
    ${row('Blocks',p.blk,c.blk)}${row('Threes made',p.fg3,c.fg3m)}${row('Turnovers',p.tov,c.tov)}
    ${prow('FG%',p.fgPct,c.fgPct)}${prow('3P%',p.fg3Pct,c.fg3Pct)}${prow('FT%',p.ftPct,c.ftPct)}${prow('TS%',p.ts,c.ts)}
  </tbody></table>`;
  const ranges=`<details class="proj-ranges"><summary>Show historical reference ranges</summary><p class="tiny">These ranges use residuals from the prior veteran model. The roster-minute and rookie additions have not been calibrated against those errors, so treat these as historical context rather than calibrated odds.</p>
    <table class="compare-table"><thead><tr><th class="left">Per game</th><th>Low reference</th><th>Estimate</th><th>High reference</th></tr></thead><tbody>
    ${[['Games',c.gpLo,c.gp,c.gpHi,0],['Minutes',c.mpgLo,c.mpg,c.mpgHi,1],['Points',c.ptsLo,c.pts,c.ptsHi,1],['Rebounds',c.rebLo,c.reb,c.rebHi,1],['Assists',c.astLo,c.ast,c.astHi,1]].map(([l,lo,v,hi,d])=>`<tr><td class="left">${l}</td><td>${num(lo,d)}</td><td><b>${num(v,d)}</b></td><td>${num(hi,d)}</td></tr>`).join('')}
    </tbody></table></details>`;

  const items=[];
  const statusText={same:`back with ${esc(c.team)}`,new:`with a new team, ${esc(c.team)}`,rookie:`on the published ${esc(c.team)} roster; role is estimated from historical rookie cohorts`,historical:`on the published ${esc(c.team)} roster; this estimate uses older NBA history after a long gap`,unsigned:'not on a published 2026-27 NBA roster yet; this line assumes he signs and plays',
    'nba-roster':'on a 2026-27 NBA roster; this is his G League line if he plays there',gleague:`in the G League, last with ${esc(c.team)}`}[c.status]||'';
  items.push(`<b>Team.</b> ${statusText}.${c.status==='new'?` The legacy team-change factor adjusts shot volume ${Math.abs((w.team?.newTeam||0)*100).toFixed(0)}% in this estimate.`:''}`);
  if(w.seasons?.length) items.push(`<b>Seasons used.</b> ${w.seasons.map(x=>`${esc(x.season)} ${esc(x.team)}, ${x.gp} games (weight ${Number(x.weight).toFixed(2)})`).join('; ')}. ${Number(w.possessions||0).toLocaleString()} possessions in all.`);
  if(w.ownShare&&c.basis==='rookie-cohort-fallback') items.push(`<b>Historical rookie cohort vs. position norm.</b> Comparable first-year players supply ${Math.round(w.ownShare.fga*100)}% of the shot-volume estimate, ${Math.round(w.ownShare.reb*100)}% of rebounds, ${Math.round(w.ownShare.ast*100)}% of assists and ${Math.round(w.ownShare.fg3*100)}% of three-point volume. His own NBA stats are not available; the rest is regressed to current positional rates.`);
  else if(w.ownShare) items.push(`<b>Own record vs. position norm.</b> His own numbers carry ${Math.round(w.ownShare.fga*100)}% of the weight on shot volume, ${Math.round(w.ownShare.reb*100)}% on rebounds, ${Math.round(w.ownShare.ast*100)}% on assists and ${Math.round(w.ownShare.fg3*100)}% on 3P%; the rest comes from a typical ${esc(p.positionFamily||'player')} at his position.`);
  if(w.age&&finite(c.age)) items.push(`<b>Age ${c.age} in 2026-27.</b> Shot volume ${pctChange(w.age.scoring)}, free throws ${pctChange(w.age.freeThrows)}, rebounds ${pctChange(w.age.rebounds)}, assists ${pctChange(w.age.assists)}, steals ${pctChange(w.age.steals)}, blocks ${pctChange(w.age.blocks)}, from how players his age changed from one season to the next.`);
  if(finite(w.development)&&Math.abs(w.development)>=0.001) items.push(`<b>Early career.</b> Season ${w.yearsIn} in the league: shot volume ${pctChange(w.development)} for development, more for higher draft picks.`);
  if(w.minutes){
    const m=w.minutes, eff=m.effects||{};
    const parts=[['age',eff.age],['a new team',eff.newTeam],[`teammates' minutes`,eff.depth],['draft slot and youth',eff.draftAndYouth]]
      .filter(([,v])=>finite(v)&&Math.abs(v)>=0.1).map(([k,v])=>`${k} ${signed(v)}`);
    const evidenceLead=c.basis==='rookie-cohort-fallback'?'No NBA role history; draft/position cohort and roster competition set his role.':c.basis==='older-history-fallback'?'Older NBA minutes are discounted after a long gap; this is a low-support return estimate.':`${num(m.last)} in ${c.basis==='older-history-fallback'?'his last active season':'2025-26'}`;
    items.push(`<b>Minutes.</b> ${evidenceLead}${finite(m.lateSeason)?`, ${num(m.lateSeason)} after the All-Star break`:''}${finite(m.startRate)?`, started ${Math.round(m.startRate*100)}% of his games`:''}. Projected ${num(m.projected)} per game he plays${finite(m.teamBudgetAdjustment)&&Math.abs(m.teamBudgetAdjustment)>=0.1?`; roster-minute allocation ${signed(m.teamBudgetAdjustment)} MPG`:''}.${parts.length?` Other model adjustments: ${parts.join(', ')}.`:''}`);
  }
  if(w.games) items.push(`<b>Games.</b> Played ${Math.round((w.games.lastShare||0)*100)}% of his team's games last season; projected ${Math.round((w.games.projectedShare||0)*100)}%, or about ${Math.round(c.gp)} of ${games}.`);
  if(w.team&&p.league==='NBA'&&c.status!=='unsigned'){
    const bal=w.team.rosterBalance, u=w.team.usage;
    const balText=finite(bal)&&Math.abs(bal-1)>=0.005?` His 2026-27 teammates create ${Math.abs((bal-1)*100).toFixed(1)}% ${bal<1?'fewer':'more'} shots per possession than a typical rotation, so his shot volume goes ${u>=0?'up':'down'} ${Math.abs(u*100).toFixed(1)}%.`:'';
    items.push(`<b>Team context.</b> ${esc(c.team)} projected pace ${num(w.team.pace)} possessions per 48 minutes (league ${num(w.team.leaguePace)}).${balText}`);
  }
  const s=w.pts100||{};
  const baselineLabel=c.basis==='rookie-cohort-fallback'?'rookie cohort':c.basis==='older-history-fallback'?'last active season':'last season';
  const blendLabel=c.basis==='rookie-cohort-fallback'?'cohort rates':'multi-season blend';
  const steps=[[baselineLabel,s.last],[blendLabel,s.blended],['after age',s.aged],['with team context',s.final]].filter(([,v])=>finite(v));
  const chain=steps.length?`<div class="proj-steps"><b>Points per 100 possessions:</b> ${steps.map(([k,v])=>`<span>${num(v)} <i>${k}</i></span>`).join(' → ')}</div>`:'';
  return `<div class="proj-card"><div class="section-bar">2026-27 projection · ${esc(c.role||'projected role')}</div>
    <div class="proj-body"><div>${table}${ranges}</div>
      <details class="proj-why"><summary>How this line was built</summary><ul>${items.map(x=>`<li>${x}</li>`).join('')}</ul>${chain}
      <p class="tiny">Availability uses historical appearance rates. Injury clearance and contract security are not verified here.
      <button class="text-button" type="button" data-proj-method>How the projections work</button></p></details></div></div>`;
}

/** The method page: the formula, every factor, and how well it did on a season it never saw. */
function openProjectionMethod(){
  const m=DATA.projectionMeta;
  if(!m){ return; }
  const b=m.backtest?.nba||{}, mae=b.mae||{};
  const pr=m.params||{}, R=pr.regressionPossessions||{}, Rp=pr.shootingRegressionAttempts||{}, team=pr.team||{};
  const labels={mpg:'Minutes',gp:'Games',pts:'Points',reb:'Rebounds',ast:'Assists',stl:'Steals',blk:'Blocks',tov:'Turnovers',fg3m:'Threes made',fgPct:'FG%',fg3Pct:'3P%',ftPct:'FT%'};
  const d=(k)=>k.endsWith('Pct')?3:2;
  const accRows=Object.keys(labels).filter(k=>mae[k]).map(k=>{
    const x=mae[k], best=Math.min(x.model,x.repeat,x.avg3);
    const cell=(v)=>`<td${v===best?' class="winner"':''}>${Number(v).toFixed(d(k))}</td>`;
    return `<tr><td class="left">${labels[k]}</td>${cell(x.model)}${cell(x.repeat)}${cell(x.avg3)}</tr>`;
  }).join('');
  const gl=m.backtest?.gleague, glRows=gl?Object.entries(gl.mae).map(([k,v])=>`<tr><td class="left">${labels[k]||k}</td><td${v.model<=v.repeat?' class="winner"':''}>${v.model.toFixed(2)}</td><td${v.repeat<v.model?' class="winner"':''}>${v.repeat.toFixed(2)}</td></tr>`).join(''):'';
  const ab=b.ablation||{}, full=mae.pts?.model;
  const rookieCheck=m.rookieEvaluation;
  const teamLedgers=Object.values(m.teamBudgets||{});
  const teamLedgerRange=teamLedgers.length?`${Math.min(...teamLedgers.map(x=>x.allocated)).toFixed(1)}–${Math.max(...teamLedgers.map(x=>x.allocated)).toFixed(1)} MPG across ${teamLedgers.length} rosters`:'';
  const abRows=[['noUsage','Roster shot-creation balance'],['noMoved','Team change'],['noPace','Team pace'],['noTeamContext','All three together']]
    .filter(([k])=>ab[k]).map(([k,l])=>`<tr><td class="left">${l}</td><td>${Number(ab[k].pts).toFixed(3)}</td><td>${finite(full)?(ab[k].pts-full>=0?'+':'')+(ab[k].pts-full).toFixed(3):''}</td></tr>`).join('');
  const w=pr.recencyWeights||[1,0,0], sw=pr.shootingWeights||[1,0,0];
  $('projMethodBody').innerHTML=`<div class="proj-method">
    <h2>How the 2026-27 projections work</h2>
    <p>These are preseason estimates for the 2026-27 regular season. Veteran statistical rates and the base role model come from a frozen fitted card. The current roster-minute reconciliation and rookie fallback were added afterward; the historical accuracy table below does not validate those additions.</p>
    <h3>The formula</h3>
    <div class="formula">per-game stat = rate per 100 possessions x possessions per game
possessions per game = projected minutes x team pace / 48

rate = BASE x AGE x DEVELOPMENT x ROSTER BALANCE x TEAM CHANGE
BASE = (w1 x stat[2025-26] + w2 x stat[2024-25] + w3 x stat[2023-24] + R x position norm)
       / (w1 x poss[2025-26] + w2 x poss[2024-25] + w3 x poss[2023-24] + R)
shooting % = (weighted makes + R x expected %) / (weighted attempts + R), then aged</div>
    <h3>What goes in</h3>
    <ul>
      <li><b>Recent seasons.</b> The last three seasons, weighted ${w.map(x=>Number(x).toFixed(2)).join(' / ')} from newest to oldest, possession by possession. Shooting percentages remember further back (${sw.map(x=>Number(x).toFixed(2)).join(' / ')}) because touch changes more slowly than role.</li>
      <li><b>How much to trust a small sample.</b> Each stat is pulled toward a typical player at the same position by R possessions of that typical player. R was chosen by testing: ${Object.entries(R).map(([k,v])=>`${k.toUpperCase()} ${v}`).join(', ')}. For shooting it is counted in attempts: 2P% ${Rp.fg2}, 3P% ${Rp.fg3}, FT% ${Rp.ft}. Three-point percentage regresses the most; free throws the least.</li>
      <li><b>Age.</b> A separate aging curve for each recorded box-score stat, estimated from year-to-year player changes. It describes population averages and does not directly measure athleticism, speed or health.</li>
      <li><b>Development.</b> Players in their first four seasons get an extra adjustment beyond age, larger for higher draft picks.</li>
      <li><b>Minutes.</b> A fitted model of minutes per game from the last three seasons, minutes after the All-Star break, how often he started, age, experience and draft slot, how productive he is per possession, whether he changed teams, and how crowded his 2026-27 roster is.</li>
      <li><b>Games.</b> A fitted model of the share of games played from the last three seasons, the end of last season, age, role and a team change.</li>
      <li><b>Roster shot-creation balance.</b> If his 2026-27 teammates create fewer shots than a typical rotation, he takes more, and the reverse. Strength ${team.usageMu??'—'} (0 would mean no effect).</li>
      <li><b>Team change.</b> The frozen model applies a ${Math.abs((team.movedUsage||0)*100).toFixed(0)}% shot-volume adjustment to a player marked as moving teams. This coefficient is a model assumption, not a promise about an individual.</li>
      <li><b>Pace.</b> Per-game numbers use his 2026-27 team's pace, which carries over from last season at a rate of ${team.paceRho??'—'}.</li>
      <li><b>Roster opportunity.</b> The NBA roster snapshot is dated ${esc(longDate(m.rostersAsOf))}. For players with recent NBA history, the fitted role estimate is reconciled across the listed roster so expected minutes sum to 240 per team game after weighting by projected appearance share. This is a preseason allocation across everyone on the roster, not a guarantee that the team has a fixed 240-minute healthy rotation every night. Players without recent history use a separate rookie-cohort fallback based on draft slot, position, historical first-season roles and roster competition; it currently lacks verified college/international statistics and contract-security inputs.</li>
      <li><b>Availability and uncertainty.</b> Games played is a historical participation estimate. The model has no verified live injury clearance or news feed. Displayed ranges come from the older veteran model and have not been recalibrated for the current roster-minute or rookie changes.</li>
    </ul>
    <h3>Historical check of the frozen model</h3>
    <p>The base model was fitted on seasons through 2024-25 and tested on ${esc(b.season)} for ${b.n} players with an NBA history. The comparison is a useful baseline check, but it predates the current 2026-27 roster-minute reconciliation and rookie fallback. It is not an accuracy score for today’s full projection.</p>
    <div class="table-wrap"><table class="compare-table"><thead><tr><th class="left">Stat</th><th>This model</th><th>Repeat last season</th><th>3-season average</th></tr></thead><tbody>${accRows}</tbody></table></div>
    <p class="tiny">${esc(m.backtest?.development||'')}</p>
    ${teamLedgerRange?`<h3>Roster-minute accounting</h3><p>All ${teamLedgers.length} NBA roster ledgers currently allocate ${teamLedgerRange}; player minutes are weighted by their expected appearance share. This verifies arithmetic feasibility, not that the predicted rotation is correct.</p>`:''}
    ${rookieCheck?`<h3>Rookie fallback check</h3><p>On a retrospective ${esc(rookieCheck.season)} cohort (${rookieCheck.n} indexed entrants), the historical cohort fallback missed expected effective minutes by ${Number(rookieCheck.effectiveMinutesMae).toFixed(2)} per player, versus ${Number(rookieCheck.unconditionedCohortMinutesMae).toFixed(2)} for its unconditioned cohort average. Points miss among ${rookieCheck.appeared} who appeared was ${Number(rookieCheck.pointsMaeAmongAppearances).toFixed(2)} per game. ${esc(rookieCheck.limitations)}</p>`:''}
    ${abRows?`<h3>What the team factors add</h3><p>Average points miss on ${esc(b.season)} with one team factor switched off (the full model misses by ${finite(full)?Number(full).toFixed(3):'—'}):</p>
      <table class="compare-table"><thead><tr><th class="left">Switched off</th><th>PTS miss</th><th>Change</th></tr></thead><tbody>${abRows}</tbody></table>
      <p class="tiny">The team factors help, but modestly. Most of the accuracy comes from the minutes and games models and from pulling small samples toward the norm. A factor that did not help in testing (a minutes-change effect on shot volume) was left out.</p>`:''}
    ${gl?`<h3>G League</h3><p>The G League uses the same formula with its own fitted weights, pulls and age curves, and a simpler minutes model, since G League rosters change too fast within a season for team context. Tested on ${esc(gl.season)} (${gl.n} players):</p>
      <table class="compare-table"><thead><tr><th class="left">Stat</th><th>This model</th><th>Repeat last season</th></tr></thead><tbody>${glRows}</tbody></table>
      <p class="tiny">G League free throws: since 2019-20 one free throw can be worth the whole trip, so points per free throw made are taken from the league (about 1.67), not assumed to be 1.</p>`:''}
    <h3>What it does not know</h3>
    <ul>
      <li>Injuries, trades, signings, contract type or role news after ${esc(longDate(m.rostersAsOf))}. For an unsigned player, this estimate assumes he signs and plays; it is not a current-roster statement.</li>
      <li>Coaching changes and scheme, beyond team pace and roster balance.</li>
      <li>College/international box-score production is not in the rookie fallback, and absence or return-to-play risk is not assessed from a verified medical source.</li>
      <li>Per-game rates are conditional on appearing; projected games are a separate estimate. Season totals multiply those two assumptions.</li>
    </ul>
    <p class="tiny">Model ${esc(m.id)} · inputs sha256 ${esc(m.inputsSha256)} · ${m.counts?.nba?.scored??'—'} NBA and ${m.counts?.gleague?.scored??'—'} G League players projected.</p>
  </div>`;
  $('projMethodDialog').showModal();
}
document.addEventListener('click',e=>{
  const t=e.target.closest&&e.target.closest('[data-proj-method]');
  if(t){ e.preventDefault(); openProjectionMethod(); }
});

function openPlayer(id){
  const p=displayedRow(id); if(!p)return;

  // Roster-only players have no performance to show. grade is null by design, so the normal
  // hero would throw on p.grade.toFixed(4).
  if(p.rosterOnly){
    $('playerDialogBody').innerHTML=`<div class="player-hero"><div>
        <div class="eyebrow">${esc(p.leagueLabel)} · NO APPEARANCE</div>
        <h2>${esc(p.name)}</h2>
        <p>${esc(p.league==='NBA'?(p.currentTeam||p.team||'Unsigned'):(p.team||'—'))} · ${esc(p.position||'—')} · ${p.age??'—'} yrs · ${esc(p.height||'—')}</p>
        <p class="tiny">${p.currentRoster?'On the current 2026-27 NBA roster snapshot with no 2025-26 NBA performance row.':'Rostered in 2025-26 but never played a game.'}</p></div></div>
      <div class="player-grid">
        <div class="detail-card"><div class="k">Performance grade</div><div class="v">N/A</div></div>
        <div class="detail-card"><div class="k">Rank</div><div class="v">N/A</div></div>
        <div class="detail-card"><div class="k">Games played</div><div class="v">0</div></div>
      </div>
      <p class="tiny">A grade of 0 would rank this player below everyone who did play, which is a
      different and false claim, so no grade is assigned.</p>`;
    $('playerDialog').showModal();
    return;
  }
  const c=counterpart(p);
  const crossover=c?`<div class="crossover">
      <div class="eyebrow">SAME PLAYER, OTHER LEAGUE</div>
      <table class="compare-table"><thead><tr><th class="left">Metric</th><th>${esc(p.leagueLabel)}</th><th>${esc(c.leagueLabel)}</th></tr></thead>
      <tbody>${[['Overall rank','rank'],['Grade','grade'],['Games','gp'],['MIN','mpg'],['PTS','pts'],['REB','reb'],['AST','ast'],['TS%','ts'],['USG%','usg'],['PIE','pie'],['NetRtg','netRtg']]
        .map(([lab,k])=>`<tr><td class="left">${lab}</td><td>${fmt(get(p,k),colDef(k).type)}</td><td>${fmt(get(c,k),colDef(k).type)}</td></tr>`).join('')}</tbody></table>
      <p class="tiny">Each league is graded against its own population, so the two grades are not on a shared scale.</p>
    </div>`:'';

  const scopeNote=p.teamScopedTo?`<p class="tiny"><b>Showing ${esc(p.teamScopedTo)} stint only.</b>
      Season line: ${p.seasonGp} games, grade ${finite(p.seasonGrade)?p.seasonGrade.toFixed(4):'—'}.
      Advanced, custom and raw fields are published per season, not per stint, so they are omitted here.</p>`:'';
  const stints=(p.teams||[]).length>1||(p.teams||[]).length===1&&(p.teamCount||1)>1?`
    <div class="crossover">
      <div class="eyebrow">TEAM HISTORY THIS SEASON</div>
      <table class="compare-table"><thead><tr><th class="left">Team</th><th>G</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>FG%</th><th>3P%</th><th>+/-</th></tr></thead>
      <tbody>${p.teams.map(s=>`<tr><td class="left">${esc(s.team)}</td><td>${s.gp}</td><td>${num(s.mpg)}</td><td>${num(s.pts)}</td><td>${num(s.reb)}</td><td>${num(s.ast)}</td><td>${pct(s.fgPct)}</td><td>${pct(s.fg3Pct)}</td><td>${signed(s.plusMinus,0)}</td></tr>`).join('')}</tbody></table>
      <p class="tiny">The headline row above aggregates every stint. Stint lines are per team.</p>
    </div>`:'';

  const customCards=CUSTOM_KEYS.map(k=>{
    const key=k.slice(7), v=p.custom?.[key];
    return finite(v)?`<div class="detail-card"><div class="k">${esc(colDef(k).label)}</div><div class="v">${fmt(v,colDef(k).type)}</div></div>`:'';
  }).join('');

  const groups={};
  for(const [k,v] of Object.entries(p.stats||{})){
    const m=k.match(/^(off|oadv|omisc|oscore|ousage|odef|obio|bref|hustle|trk|split|op36|op100)_/);
    const g=m?SRC_LABEL[m[1]]:'Other';
    (groups[g]=groups[g]||[]).push([k,v]);
  }
  const raw=Object.entries(groups).map(([g,items])=>
    `<h4>${esc(g)} <span class="tiny">${items.length} fields</span></h4><div class="raw-grid">${
      items.sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`<div class="raw-row"><span>${esc(humanize(k).replace(/^[^·]+· /,''))}</span><b>${fmt(v,'')}</b></div>`).join('')
    }</div>`).join('');

  const split=p.showcaseGP>0
    ? `<p class="tiny">Season line combines ${p.regularGP} Regular Season and ${p.showcaseGP} Showcase Cup games.${p.brefScope==='regular-season-only'?` Basketball-Reference PER/WS below cover only ${p.brefGP} regular-season games.`:''}</p>` : '';
  const draft=p.draftStatus==='drafted'
    ? `drafted ${esc(p.draftYear)} rd ${esc(p.draftRound)} pick ${esc(p.draftNumber)}`
    : p.draftStatus==='undrafted' ? 'undrafted' : 'draft status unknown';

  // TULIP Beta. Always rendered with its experimental status and with where the minutes come from —
  // a reallocation number is meaningless without the other side of the ledger.
  const tbeta=(()=>{
    const c=p.tulipBeta;
    const meta=DATA.tulipBetaMeta||{};
    if(!c) return '';
    if(c.abstain){
      const why={
        not_supported_for_gleague:'TULIP Beta is NBA-only: the G League publishes no BPM and this build has no standardized-PIE value implementation, so no recommendation is made rather than improvising one.',
        not_on_current_nba_roster:'This player is not on the current 2026-27 NBA roster snapshot, so no current-team allocation recommendation is made.',
        insufficient_minutes:'Too few minutes played this season to place him in the reallocation pool.',
        below_rotation_threshold:'Below the rotation-minutes threshold, so he is not an allocation candidate.',
        no_value_metric:'No value metric available for this player.',
        no_appearance:'Has not appeared this season.',
        team_roster_too_small:'Too few eligible team-mates to form a conserving allocation.',
      }[c.reason]||'No supported recommendation for this player.';
      return `<div class="crossover"><div class="eyebrow">TULIP BETA \u2014 NO RECOMMENDATION</div>
        <p class="tiny">${esc(why)} A value of 0.0 would falsely read as \u201calready at the right workload\u201d, so none is shown.</p></div>`;
    }
    // the other side of the ledger: who on this team gives up / receives these minutes
    const team=p.league==='NBA'?(p.currentTeam||p.team):p.team;
    const mates=(DATA.leagues[p.league]||[]).filter(x=>(x.league==='NBA'?(x.currentTeam||x.team):x.team)===team&&x.playerId!==p.playerId
      &&x.tulipBeta&&!x.tulipBeta.abstain&&Math.sign(x.tulipBeta.tulip)===-Math.sign(c.tulip)&&x.tulipBeta.tulip!==0)
      .sort((a,b)=>Math.abs(b.tulipBeta.tulip)-Math.abs(a.tulipBeta.tulip)).slice(0,5);
    const dir=c.tulip>0?'sourced from':'returned to';
    const mateRows=mates.length?`<table class="compare-table"><thead><tr><th class="left">Minutes ${esc(dir)}</th><th>Baseline</th><th>TULIP</th><th>Recommended</th></tr></thead><tbody>${
      mates.map(m=>`<tr><td class="left">${esc(m.name)}</td><td>${num(m.tulipBeta.currentMpg)}</td><td>${signed(m.tulipBeta.tulip)}</td><td>${num(m.tulipBeta.recommendedMpg)}</td></tr>`).join('')
    }</tbody></table>`:'<p class="tiny">No opposite-direction team-mates listed.</p>';
    return `<div class="crossover"><div class="eyebrow">TULIP BETA \u00b7 EXPERIMENTAL</div>
      <div class="player-grid">
        <div class="detail-card"><div class="k">TULIP</div><div class="v">${signed(c.tulip)} MPG</div></div>
        <div class="detail-card"><div class="k">Baseline MPG</div><div class="v">${num(c.currentMpg)}</div></div>
        <div class="detail-card"><div class="k">Recommended MPG</div><div class="v">${num(c.recommendedMpg)}</div></div>
        <div class="detail-card"><div class="k">Support</div><div class="v">${esc(c.confidence||'\u2014')}</div></div>
      </div>
      <p class="tiny"><b>What this says.</b> TULIP Beta recommends <b>${signed(c.tulip)} MPG</b> for this
      player \u2014 the heuristic flags him for ${c.tulip > 0 ? 'more' : c.tulip < 0 ? 'fewer' : 'about the same'}
      minutes relative to his ${esc(c.baselineLabel||'2025-26 MPG baseline')} on the current roster context. That is a recommendation from this model, not an established fact about how he is being used.</p>
      ${whyTulipBlock(p,c)}
      ${mateRows}
      <p class="tiny"><button class="button" data-teamalloc="${esc(p.currentTeam||p.team||'')}">View ${esc(p.currentTeam||p.team||'team')} TULIP Allocation</button></p>
      <p class="tiny"><b>Status: experimental beta.</b> The direction is based on team-relative player
      value; the magnitude is constrained by workload/role evidence and a zero-sum roster allocator.
      Historical causal testing did not establish that either the play-more/play-less direction or the exact MPG deltas improve winning, so treat
      these as decision-support estimates rather than validated coaching prescriptions. The Support
      rating above describes the strength of the evidence behind the inputs \u2014 it is NOT a
      probability that the recommendation is correct.</p></div>`;
  })();

  // Projected Role MPG. Never rendered without its uncertainty range, and never rendered at all
  // where V1 abstains — an abstention is shown as an explicit reason, not as a number.
  const tcap=(()=>{
    const c=p.tulipCapacity;
    const meta=DATA.tulipCapacityMeta||{};
    if(!c) return '';
    if(c.abstain){
      const why={
        not_validated_for_gleague:'This projection is not validated for G League-to-NBA or G League team changes, so no value is shown.',
        insufficient_team_a_history:'Not enough games this season to support a prediction (V1 requires at least 20).',
        missing_required_workload_inputs:'Required workload inputs are unavailable for this player.',
        missing_required_production_inputs:'Required production inputs are unavailable for this player.',
        no_game_log_for_source_season:'No game log for the source season.',
        no_rows:'No game rows for the source season.',
      }[c.reason]||'V1 could not produce a supported prediction for this player.';
      return `<div class="crossover"><div class="eyebrow">PROJECTED ROLE MPG \u2014 INSUFFICIENT EVIDENCE</div>
        <p class="tiny">${esc(why)} A value of 0.0 would be a false claim, so none is shown.</p>
        <p class="tiny">Frozen model id: ${esc(meta.version||'TULIP_CAPACITY_V1')} \u00b7 ${esc(meta.cardSha256?'card-sha256:'+meta.cardSha256:'')} <i>(internal artifact identifier; the shipped metric is Projected Role MPG, not a capacity estimate)</i></p></div>`;
    }
    return `<div class="crossover"><div class="eyebrow">PROJECTED ROLE MPG \u00b7 ${esc(c.scopeLabel||'')}</div>
      <div class="player-grid">
        <div class="detail-card"><div class="k">Projected Role MPG</div><div class="v">${num(c.capacityMpg)} MPG</div></div>
        <div class="detail-card"><div class="k">Current MPG</div><div class="v">${num(c.teamASeasonMpg)}</div></div>
        <div class="detail-card"><div class="k">Proj vs current</div><div class="v">${signed(c.headroom)}</div></div>
        <div class="detail-card"><div class="k">50% likely range</div><div class="v">${num(c.interval50Low)}\u2013${num(c.interval50High)}</div></div>
        <div class="detail-card"><div class="k">Evidence</div><div class="v">${esc(c.evidenceNote||'\u2014')}</div></div>
      </div>
      <p class="tiny"><b>What this means.</b> The MPG this player is likely to RECEIVE AND SUSTAIN
      after an offseason move to another NBA team, predicted from his own previous-team history only.
      No destination-team information is used.</p>
      <p class="tiny"><b>This is not a capacity metric.</b> It does not estimate how many minutes he
      could effectively handle. It predicts an observed rotation outcome, which reflects coach
      preference, depth chart, roster construction, injuries, contract status and team strategy as
      much as the player himself. A high-minute star can project BELOW his current minutes simply
      because players at that workload historically regress after changing teams &mdash; a statement
      about rotations, not about him. Predictive, not causal, and NOT validated for in-season
      trades.</p>
      <p class="tiny"><b>How good is it?</b> Against the strongest simple baseline (Team A season MPG,
      MAE 5.087) V1 reaches MAE 4.964 on 970 offseason transitions \u2014 an incremental gain of
      +0.122 MPG, 95% CI [0.035, 0.221]. Among two players with the same Team A season MPG it picks
      the one who sustains more 54.7% of the time versus 51.0% for the baseline, rising to 68.1% when
      it separates them by 5+ MPG. Real and statistically supported, but incremental \u2014 the 50%
      range is about 8.7 MPG wide, so use it to compare players rather than as an exact forecast.</p>
      <p class="tiny">The evidence letter (A \u2265300, B \u2265150, C \u226560, D &lt;60 comparable
      transitions) is a convenience label for readability, not a statistical guarantee; the raw count
      is shown beside it. Frozen model id: ${esc(c.version||'TULIP_CAPACITY_V1')} \u00b7
      ${esc(meta.cardSha256?'card-sha256:'+meta.cardSha256:'')} <i>(internal artifact identifier; the
      shipped metric is Projected Role MPG, not a capacity estimate)</i></p></div>`;
  })();

  $('playerDialogBody').innerHTML=`<div class="player-hero"><div><div class="eyebrow">${esc(p.leagueLabel)}${finite(p.rank)?` · RANK #${p.rank} of ${DATA.counts[p.league]}`:''}</div>
      <h2>${esc(p.name)}</h2>${scopeNote}
      <p>${esc(p.league==='NBA'?(p.currentTeam||'Unsigned'):(p.team||'—'))} · ${esc(p.position||'—')} · ${p.age??'—'} yrs · ${esc(p.height||'—')} · ${p.weight?p.weight+' lb':'—'} · ${esc(p.country||'—')}${p.league==='NBA'&&p.seasonTeam&&p.seasonTeam!==p.currentTeam?` · 2025-26: ${esc(p.seasonTeam)}`:''}</p>
      <p class="tiny">${p.gp} games · ${num(p.mpg)} mpg · ${p.college?esc(p.college)+' · ':''}${draft}</p>${split}</div></div>
    <div class="player-grid">
      <div class="detail-card"><div class="k">Performance grade</div><div class="v grade ${gradeClass(p.grade)}">${finite(p.grade)?p.grade.toFixed(4):'N/A'}</div></div>
      <div class="detail-card"><div class="k">PTS / REB / AST</div><div class="v">${num(p.pts)}/${num(p.reb)}/${num(p.ast)}</div></div>
      <div class="detail-card"><div class="k">TS% / USG%</div><div class="v">${pct(p.ts)} / ${pctPoints(p.usg)}</div></div>
      <div class="detail-card"><div class="k">PIE / NetRtg</div><div class="v">${pct(p.pie)} / ${signed(p.netRtg)}</div></div>
      <div class="detail-card"><div class="k">Reliability weight</div><div class="v">${num(p.reliabilityWeight,1)}</div></div>
      <div class="detail-card"><div class="k">Rate grade (per 36)</div><div class="v">${finite(p.rateGrade)?p.rateGrade.toFixed(4):'—'}</div></div>
      <div class="detail-card"><div class="k">Magnitude grade</div><div class="v">${finite(p.magnitudeGrade)?p.magnitudeGrade.toFixed(4):'—'}</div></div>
      <div class="detail-card"><div class="k">Ingredient coverage</div><div class="v">${num(p.gradeCoverage,1)}%<span class="tiny">${Object.entries(p.gradeCoverageDetail||{}).map(([k,v])=>`${k.slice(0,4)} ${v}`).join(' · ')}</span></div></div>
      ${p.cohortRanks?.position?`<div class="detail-card"><div class="k">Among ${esc(p.positionFamily)}</div><div class="v">#${p.cohortRanks.position.rank} <span class="tiny">of ${p.cohortRanks.position.of}</span></div></div>`:''}
      ${p.cohortRanks?.team?`<div class="detail-card"><div class="k">2025-26 ${esc(p.seasonTeam||p.team)}</div><div class="v">#${p.cohortRanks.team.rank} <span class="tiny">of ${p.cohortRanks.team.of}</span></div></div>`:''}
      ${p.cohortRanks?.ageGroup?`<div class="detail-card"><div class="k">${(p.ageOpeningNight??p.age)<=23?'Age 23 and under':'Age 24+'} <span class="tiny">on opening night</span></div><div class="v">#${p.cohortRanks.ageGroup.rank} <span class="tiny">of ${p.cohortRanks.ageGroup.of}</span></div></div>`:''}
      ${customCards}
    </div>${projCard(p)}${stints}${tbeta}${tcap}${crossover}
    <details class="ws-disclosure"><summary>All retained source fields</summary><div class="ws-disclosure-body">${raw}</div></details>`;
  $('playerDialog').showModal();
}

function openCompare(){
  // Compare the rows as displayed, so team-only mode is not silently undone here either.
  const ps=[...compared].map(id=>displayedRow(id)).filter(Boolean);
  const scoped=ps.filter(p=>p.teamScopedTo);
  // TULIP leads the comparison: the whole point of comparing two players is often "which of these
  // should be playing more", and a row that silently omits it makes the tool answer a lesser question.
  const rows=['tb.tulip','tb.currentMpg','tb.recommendedMpg','tb.confidence','tb.valueGapSd',
    'rank','grade','gp','mpg','pts','reb','ast','stl','blk','tov','ts','efg','usg','astPct','rebPct',
    'offRtg','defRtg','netRtg','pie','per','ws48','bpm','vorp',...CUSTOM_KEYS,
    'proj.team','proj.gp','proj.mpg','proj.pts','proj.reb','proj.ast','proj.fg3m','proj.ts'];
  $('compareDialogBody').innerHTML=`<h2>Player comparison</h2>`
    +(scoped.length?`<p class="tiny">${scoped.map(p=>esc(p.name)+' — '+esc(p.teamScopedTo)+' stint only').join(' · ')}</p>`:'')
    +`<div class="table-wrap"><table class="compare-table"><thead><tr><th class="left">Metric</th>${ps.map(p=>`<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>${
    rows.filter(k=>ps.some(p=>{const v=get(p,k);
      // text columns (e.g. Confidence) are never "finite", so keep any non-empty value too
      return colDef(k).type==='text' ? (v!==null&&v!==undefined&&v!=='') : finite(v);})).map(k=>`<tr><td class="left">${esc(colDef(k).label)}</td>${ps.map(p=>`<td>${fmt(get(p,k),colDef(k).type)}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div>`;
  $('compareDialog').showModal();
}

function openFieldCatalog(){
  const cat=DATA.fieldCatalog||{};
  const rows=Object.entries(cat).filter(([k])=>k.startsWith(league+':'))
    .map(([,v])=>v).sort((a,b)=>a.label.localeCompare(b.label));
  const render=(q)=>{
    const f=rows.filter(r=>!q||fold(r.label+r.field+r.source).includes(fold(q)));
    $('catalogRows').innerHTML=`<p class="tiny">${f.length} of ${rows.length} fields</p>`
      +`<div class="table-wrap"><table class="compare-table"><thead><tr>
      <th class="left">Field</th><th class="left">Label</th><th class="left">Source</th>
      <th class="left">Unit</th><th class="left">Basis</th><th class="left">Season scope</th><th class="left">Direction</th></tr></thead><tbody>`
      +f.slice(0,400).map(r=>`<tr><td class="left"><code>${esc(r.field)}</code></td><td class="left">${esc(r.label)}</td>
        <td class="left">${esc(r.source)}</td><td class="left">${esc(r.unit)}</td><td class="left">${esc(r.basis)}</td>
        <td class="left">${esc(r.seasonScope)}</td><td class="left">${esc(r.direction)}</td></tr>`).join('')
      +`</tbody></table></div>`+(f.length>400?'<p class="tiny">Showing the first 400; refine the search to narrow.</p>':'');
  };
  $('catalogDialogBody').innerHTML=`<div class="eyebrow">DATA DICTIONARY</div>
    <h2>Field catalog — ${esc(league==='NBA'?'NBA':'G League')}</h2>
    <p>Every raw field with its source, unit, basis and season scope. The same concept appears as an official value, a Basketball-Reference value, a total, a per-game, a per-36 and a per-100; this is how to tell them apart.</p>
    <label class="sr-only" for="catalogSearch">Search fields</label><input id="catalogSearch" type="search" placeholder="Search fields…" />
    <div id="catalogRows"></div>`;
  render('');
  $('catalogSearch').addEventListener('input',e=>render(e.target.value));
  $('catalogDialog').showModal();
}

function openMetricDefinitions(){
  const defs=DATA.metricDefinitions||{}, notes=DATA.modelNotes||{}, gm=DATA.gradeModel||{};
  const shr=gm.shrinkage||{};
  const ing=gm.componentIngredients||{};
  $('metricDialogBody').innerHTML=`<div class="eyebrow">METHODS</div><h2>Grade and custom metric definitions</h2>
    <p>${esc(DATA.sourceNote||'')}</p>
    <p><strong>Season definition.</strong> ${esc(DATA.seasonType||'')}</p>
    ${DATA.provenance?.basketballReferenceSnapshot?.generatedAt?`<p><strong>Basketball-Reference is a snapshot.</strong> Taken ${esc(new Date(DATA.provenance.basketballReferenceSnapshot.generatedAt).toLocaleString())}. PER, win shares and the BPM/VORP family come from it and are <em>not</em> re-fetched when the rest of the database is refreshed, so they can be older than every other field in the same row.</p>`:''}
    <p><strong>Counts.</strong> ${DATA.counts.records} league-season records covering ${DATA.counts.uniquePeople} unique people; ${DATA.counts.both} played in both leagues and hold two independent records.</p>
    <p><strong>Grade scale.</strong> ${esc(gm.scale||'')} — K is ${esc(String(shr.NBA?.K??'—'))} minutes in the NBA and ${esc(String(shr.GLEAGUE?.K??'—'))} in the G League.</p>
    <h3>Component weights and ingredients</h3>
    <div class="metric-list">${Object.entries(gm.componentWeights||{}).map(([k,w])=>
      `<div class="metric-definition"><strong>${esc(k)} — ${(w*100).toFixed(0)}%</strong><span>${esc((ing[k]||[]).join(', '))}</span></div>`).join('')}</div>
    <h3>Model notes</h3>
    <div class="metric-list">${Object.entries(notes).map(([k,v])=>`<div class="metric-definition"><strong>${esc(humanize(k))}</strong><span>${esc(v)}</span></div>`).join('')}</div>
    <h3>Metric definitions</h3>
    <div class="metric-list">${Object.entries(defs).map(([k,v])=>`<div class="metric-definition"><strong>${esc(BASE_COLS['custom.'+k]?.label||colDef(k).label)}</strong><span>${esc(v)}</span></div>`).join('')}</div>`;
  $('metricDialog').showModal();
}

/** Percentile with ties averaged — the same rule the build uses. */
function percentileMap(players,key){
  const vals=players.map(p=>({p,v:get(p,key)})).filter(x=>finite(x.v)).map(x=>({...x,v:Number(x.v)}));
  vals.sort((a,b)=>a.v-b.v);
  const m=new Map();
  let i=0;
  while(i<vals.length){
    let j=i;
    while(j+1<vals.length && vals[j+1].v===vals[i].v) j++;
    const p=vals.length===1?50:100*((i+j)/2)/(vals.length-1);
    for(let k=i;k<=j;k++) m.set(vals[k].p.playerId,p);
    i=j+1;
  }
  return m;
}

/**
 * Lab score: weighted mean of within-cohort percentiles.
 *  - Ties share a percentile, so identical statistics can no longer produce different scores.
 *  - A missing ingredient is EXCLUDED and the remaining weights renormalised, rather than
 *    silently imputed as the 50th percentile.
 *  - A negative weight flips the percentile (100 - p) instead of negating the score, so the
 *    result stays on 0-100 rather than running to -100.
 */
function applyLab(){
  labConfig=[1,2,3,4].map(i=>({key:$(`labMetric${i}`).value,w:Number($(`labWeight${i}`).value)||0})).filter(x=>x.key&&x.w!==0);
  // Combining a full-season statistic with a regular-season-only one produces a polished score
  // over statistics that do not describe the same games. Blocked unless deliberately allowed.
  const scopes=[...new Set(labConfig.map(x=>scopeOf(x.key)))].filter(sc=>sc!=='situational-split');
  if(scopes.length>1 && !$('allowMixedScope').checked){
    $('labNote').innerHTML=`<b>Mixed season scopes blocked.</b> ${labConfig.map(x=>`${esc(colDef(x.key).label)} = ${esc(scopeOf(x.key))}`).join(' · ')}. `
      +`These do not cover the same games. Tick “allow mixed scopes” to proceed anyway.`;
    return;
  }
  labCohort=$('labCohort').value;
  const all=currentPlayers();
  if(!labConfig.length){all.forEach(p=>{delete p.labScore;delete p.labCoverage});render();return}
  const cohort=labCohort==='filtered'?filteredPlayers():all;
  const cohortIds=new Set(cohort.map(p=>p.playerId));
  const maps=Object.fromEntries(labConfig.map(x=>[x.key,percentileMap(cohort,x.key)]));
  for(const p of all){
    if(!cohortIds.has(p.playerId)){delete p.labScore;delete p.labCoverage;continue}
    let acc=0,wsum=0,used=0;
    for(const {key,w} of labConfig){
      const pct=maps[key].get(p.playerId);
      if(!finite(pct)) continue;
      acc+=(w<0?100-pct:pct)*Math.abs(w);
      wsum+=Math.abs(w); used++;
    }
    p.labScore = wsum>0 ? acc/wsum : null;
    p.labCoverage = `${used}/${labConfig.length}`;
  }
  sortKey='labScore';sortDir=-1;render();
  $('labNote').innerHTML=`Ranked against ${cohort.length.toLocaleString()} players (${labCohort==='filtered'?'current filtered set':'whole league'}). `
    +`Missing ingredients are excluded, not imputed. Scope: ${esc(scopes.join(' + ')||'n/a')}.`;
}

function exportNote(msg){
  const b=$('exportBtn'), original=b.dataset.label||(b.dataset.label=b.textContent);
  b.textContent=msg; setTimeout(()=>{b.textContent=original},3200);
}

async function exportCsv(){
  const cols=visibleColumns().filter(k=>k!=='select'),list=filteredPlayers();
  const q=v=>`"${String(v??'').replaceAll('"','""')}"`;
  // Header carries the unit, and percentage columns export as percentage points so a "%"
  // header never sits above a 0.612.
  const anyScoped=list.some(p=>p.teamScopedTo);
  const header=cols.map(k=>{
    const d=colDef(k);
    return q(isFraction(k)?`${d.label} (pct pts)`:d.label);
  }).concat(anyScoped?[q('Scope')]:[]).join(',');
  const lines=[header];
  for(const p of list){
    const row=cols.map(k=>{
      const v=get(p,k);
      return q(finite(v)?toDisplayUnit(k,Number(v)):v);
    });
    // Every row states its own scope, so a stint line can never be mistaken for a season line.
    if(anyScoped) row.push(q(p.teamScopedTo?`${p.teamScopedTo} stint only`:'full season'));
    lines.push(row.join(','));
  }
  const csv=lines.join('\n');
  const base=$('viewPreset').value==='proj'
    ? `${league.toLowerCase()}_2026-27_projections`
    : `${league.toLowerCase()}_2025-26_rankings`;

  const downloads=await capability('downloads');
  if(downloads){
    for(const filename of [`${base}.csv`,`${base}.txt`]){
      try{ await downloads.save({filename,data:csv}); return; }
      catch(e){
        if(e?.code==='declined') return;
        if(e?.code==='extension_not_enabled') continue;
        if(e?.code==='rate_limited'){ exportNote('Try again in a moment'); return; }
        exportNote('Export unavailable here'); return;
      }
    }
    exportNote('Export unavailable here'); return;
  }
  const blob=new Blob([csv],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`${base}.csv`;a.click();URL.revokeObjectURL(url);
}

async function capability(name){
  try{ return window.claude?.use ? await window.claude.use(name) : null; }
  catch{ return null; }
}

function reset(){
  ['searchInput','teamFilter','positionFilter','countryFilter'].forEach(id=>$(id).value='');
  ['minGp','minMpg','minMin','minGrade','minReliability'].forEach(id=>$(id).value=0);
  $('bothOnly').checked=false;if($('includeRosterOnly'))$('includeRosterOnly').checked=false;
  if($('rosterScope'))$('rosterScope').value='season';
  if($('teamMode'))$('teamMode').value='season';rules=[];render();
}

function fillMetricSelects(){
  const keys=metricRegistryKeys();
  const options=keys.map(k=>`<option value="${esc(k)}">${esc(colDef(k).label)}</option>`).join('');
  const old=[1,2,3,4].map(i=>$(`labMetric${i}`)?.value||'');
  [1,2,3,4].forEach(i=>{$(`labMetric${i}`).innerHTML=`<option value="">— metric ${i} —</option>${options}`});
  const dflt=['pts','custom.twoWayIndex','custom.efficiencyOverExpected',''];
  [1,2,3,4].forEach(i=>{$(`labMetric${i}`).value=keys.includes(old[i-1])?old[i-1]:(keys.includes(dflt[i-1])?dflt[i-1]:'')});
  $('ruleMetric').innerHTML=options;
  $('labFieldCount').textContent=keys.length.toLocaleString();
}

function switchLeague(b){
  league=b.dataset.league;
  document.querySelectorAll('.league-tab').forEach(x=>x.classList.toggle('active',x===b));
  compared.clear();rules=[];labConfig=[];sortKey='grade';sortDir=-1;
  currentPlayers().forEach(p=>{delete p.labScore;delete p.labCoverage});
  $('labNote').textContent='';
  populateSelectors();fillMetricSelects();render();
  if(window.__wsInit) window.__wsInit();
  writeUrlState('push');
}

function bind(){
  document.querySelectorAll('.league-tab').forEach(b=>b.onclick=()=>switchLeague(b));
  ['searchInput','rosterScope','teamFilter','teamMode','positionFilter','countryFilter','minGp','minMpg','minMin','minGrade','minReliability','bothOnly','includeRosterOnly','rowLimit']
    .forEach(id=>$(id).addEventListener(id==='searchInput'?'input':'change',()=>{
      render(); writeUrlState(id==='searchInput'?'replace':'push');
    }));
  // Opening TULIP Beta or the projections sorted by grade hides the point of them, so those views
  // select their own headline sort once. Any later manual sort is left alone.
  $('viewPreset').addEventListener('change',()=>{
    const own=PRESET_SORT[$('viewPreset').value];
    if(own){
      sortKey=own; sortDir=-1;
      if($('sortField')) $('sortField').value=own;
      if($('sortOrder')) $('sortOrder').value='-1';
    }
    render(); writeUrlState('push');
  });
  document.querySelectorAll('.site-link[data-goto]').forEach(b=>b.addEventListener('click',()=>goTo(b.dataset.goto)));
  $('projMethodBtn').onclick=openProjectionMethod;
  // Sort controls must SET the sort state, not merely re-render, so they get explicit handlers
  // rather than joining the generic list above.
  $('sortField').addEventListener('change',()=>{sortKey=$('sortField').value;render();writeUrlState('push');});
  $('sortOrder').addEventListener('change',()=>{sortDir=Number($('sortOrder').value)||-1;render();writeUrlState('push');});
  $('resetBtn').onclick=()=>{reset();writeUrlState('push');};$('exportBtn').onclick=exportCsv;$('aboutBtn').onclick=openMetricDefinitions;$('applyLab').onclick=()=>{applyLab();writeUrlState('push');};
  $('catalogBtn').onclick=openFieldCatalog;
  $('statGuideBtn').onclick=openStatGuide;
  // "?" opens the guide from anywhere, unless the user is typing in a field.
  document.addEventListener('keydown',(e)=>{
    if(e.key!=='?'||e.metaKey||e.ctrlKey) return;
    const t=e.target.tagName;
    if(t==='INPUT'||t==='SELECT'||t==='TEXTAREA') return;
    e.preventDefault(); openStatGuide();
  });
  $('compareBtn').onclick=openCompare;$('clearCompareBtn').onclick=()=>{compared.clear();render();writeUrlState('push');};
  $('addRuleBtn').onclick=()=>{
    $('ruleUnitHint').textContent='';
    $('ruleDialog').showModal();
  };
  $('ruleMetric').onchange=()=>{
    const k=$('ruleMetric').value;
    $('ruleUnitHint').textContent=isFraction(k)?'Enter percentage points, e.g. 60 for 60%':'';
  };
  $('saveRuleBtn').onclick=()=>{rules.push({key:$('ruleMetric').value,op:$('ruleOp').value,value:Number($('ruleValue').value)});$('ruleDialog').close();render();writeUrlState('push');};
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
}

// Bridge for workspace.js so it does not duplicate formatting, filtering or label logic.
window.__wsLeague=()=>league;
window.__wsRender=()=>render();
window.__wsFiltered=()=>filteredPlayers();
window.__wsCompared=()=>[...compared];
window.__wsLabel=(k)=>colDef(k).label;
window.__wsFmt=(v,k)=>fmt(v,colDef(k).type);

window.addEventListener('popstate',()=>{
  if(!DATA) return;
  restoreUrlState(); render(); window.__wsRefresh?.();
});

async function init(){
  try{
    const r=await fetch('./public/data.json',{cache:'no-cache'}); if(!r.ok)throw new Error(`data.json returned ${r.status}`); DATA=await r.json();
    DATA=rehydrate(DATA);
    // `let DATA` at script scope is NOT a window property, so workspace.js could not see it.
    window.DATA=DATA;
    $('nbaCount').textContent=DATA.counts.NBA.toLocaleString();$('gCount').textContent=DATA.counts.GLEAGUE.toLocaleString();
    const ro=(DATA.counts.rosterOnlyNBA||0)+(DATA.counts.rosterOnlyGLEAGUE||0);
    const rosterAsOf=DATA.projectionMeta?.rostersAsOf;
    const buildDate=new Date(DATA.generatedAt).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
    $('sourceLine').textContent=`Official NBA and G League stats: ${DATA.counts.records.toLocaleString()} player seasons for ${DATA.counts.uniquePeople.toLocaleString()} players`
      +(ro?`, plus ${ro} rostered who never played`:'')+`. ${DATA.season} stats; NBA roster snapshot ${rosterAsOf||'date unavailable'}; site built ${buildDate}.`;
    $('seasonEyebrow').textContent=DATA.seasonType;
    populateSelectors();fillMetricSelects();bind();restoreUrlState();render();
    if(window.__wsInit) window.__wsInit();
    // Links from other pages (History Lab) can open the projections directly.
    if(location.hash==='#projections' && !new URLSearchParams(location.search).has('view')) goTo('proj');
    writeUrlState('replace');
    if(window.claude && !(await capability('downloads'))) $('exportBtn').hidden=true;
  }catch(e){
    $('sourceLine').textContent='The data build has not completed yet.';
    $('tableBody').innerHTML=`<tr><td class="error">${esc(e.message)}. Run <code>npm run build</code> to generate public/data.json.</td></tr>`;
  }
}
init();
