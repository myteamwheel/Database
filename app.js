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

const get = (p, key) => {
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
  'opt.optimalMpg':{label:'TULIP MPG',type:'1',help:'WHAT: the minutes-per-game workload at which this player\u2019s projected on-court impact is highest. PLAIN: roughly how much he should play for the team to get the most out of him. FORMULA: TULIP projects impact at 12/16/20/24/28/32/36 MPG using comparable players at each workload; this is the band with the highest projection, counting only bands with enough comparables. Blank means fewer than two bands had support.'},
  'opt.minutesDelta':{label:'TULIP',type:'signed1',help:'WHAT: how many more (+) or fewer (-) minutes per game this player should be getting for the team to get the most out of him. This is the headline TULIP number. FORMULA: TULIP MPG minus his current MPG, where TULIP MPG is the workload with the highest projected impact. PLAIN: how many more (+) or fewer (-) minutes a game the evidence points to. FORMULA: opt.optimalMpg - current MPG. Positive means underused, negative means the projection peaks below what he already plays. This is an observational comparison against similar players, NOT a causal claim about what happens if his minutes change.'},
  'opt.projectedAtOptimal':{label:'Proj @ TULIP MPG',type:'signed2',help:'WHAT: projected on-court impact at the best-MPG workload. PLAIN: how good the model thinks he would be at that workload. FORMULA: the TULIP projected impact value of the winning role band.'},
  'opt.confidence':{label:'TULIP conf',type:'2',help:'WHAT: how clearly the peak stands out. PLAIN: higher means the best workload is distinct, near 0 means the curve is flat and the peak is inside the noise. FORMULA: (max projected impact across supported bands - min) / width of the best band\u2019s confidence interval.'},
  'opt.supportedBands':{label:'Bands',type:'int',help:'WHAT: how many of the seven role bands had enough comparable players to project. PLAIN: how much of the minutes range the estimate actually saw. FORMULA: count of bands (12-36 MPG) where TULIP did not abstain.'},
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
  'tulip.leagueDelta':{label:'Role Value',type:'signed2',help:'WHAT: role-expansion VALUE (not a minutes recommendation \u2014 see the TULIP column for that) against a MEDIAN league rotation slot, at the player’s target minutes. PLAIN: how much the team would gain per 100 possessions by giving him a bigger role, compared with a typical rotation player rather than with his own weakest team-mate. FORMULA: projected on-court impact at the target minutes (from comparable players at that workload) MINUS the league-median rotation-slot impact. The league reference is used because the team-referenced version correlates -0.91 with whoever would be displaced and only +0.18 with the candidate, so it mostly measures the team-mate, not the player. Blank means TULIP abstained — too few comparables, or he already plays too many minutes for expansion to be a question. Blank is NOT zero and always sorts last.'},
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
  overall:['select','viewRank','rank','name','team','position','age','gp','mpg','grade','rateGrade','magnitudeGrade','opt.minutesDelta','opt.optimalMpg','tulip.leagueDelta','pts','reb','ast','stl','blk','ts','usg','pie','netRtg','custom.twoWayIndex','reliabilityWeight'],
  workload:['select','viewRank','name','team','position','age','gp','mpg','grade','tulip.leagueDelta','opt.optimalMpg','opt.minutesDelta','opt.projectedAtOptimal','opt.confidence','opt.supportedBands'],
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

const PRESET_LABELS = {overall:'Overall',workload:'TULIP (minutes)',tulip:'Role Value (expansion)',nbaready:'NBA Readiness (G League)',per36:'Per 36 Minutes',per36nba:'Per 36 — NBA Equivalent (G League)',scoring:'Scoring',shooting:'Shooting',playmaking:'Playmaking',
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
const COLUMN_HELP = {"name": "WHAT: player name. PLAIN: who this is. Click it to open the full player card.", "team": "WHAT: team abbreviation. PLAIN: who he plays for. FORMULA: current team, or \"2 TM\" when he played for more than one; switch \"Team stats\" to see per-team stint lines.", "position": "WHAT: listed position. PLAIN: where he plays. FORMULA: taken from the official roster listing, not inferred from play style.", "positionFamily": "WHAT: grouped position (guard / wing / big). PLAIN: broad role bucket. FORMULA: collapsed from the listed position.", "positionSource": "WHAT: where the position label came from. PLAIN: which source we trust for this row. FORMULA: provenance string, not a statistic.", "gp": "WHAT: games played. PLAIN: how many games he appeared in. FORMULA: count of games with any playing time.", "regularGP": "WHAT: regular-season games played. PLAIN: games excluding the G League Showcase Cup. FORMULA: count of Regular Season games only.", "showcaseGP": "WHAT: Showcase Cup games played (G League). PLAIN: games in the Tip-Off tournament. FORMULA: count of Showcase games only. The G League season splits into Showcase and Regular Season; neither alone is a full season.", "mpg": "WHAT: minutes per game. PLAIN: how much he plays. FORMULA: total minutes / games played.", "minutes": "WHAT: total minutes. PLAIN: season workload. FORMULA: sum of minutes across all games.", "pts": "WHAT: points per game. PLAIN: scoring. FORMULA: total points / games played.", "reb": "WHAT: rebounds per game. FORMULA: (offensive + defensive rebounds) / games played.", "oreb": "WHAT: offensive rebounds per game. FORMULA: total offensive rebounds / games played.", "dreb": "WHAT: defensive rebounds per game. FORMULA: total defensive rebounds / games played.", "ast": "WHAT: assists per game. FORMULA: total assists / games played.", "stl": "WHAT: steals per game. FORMULA: total steals / games played.", "blk": "WHAT: blocks per game. FORMULA: total blocks / games played.", "tov": "WHAT: turnovers per game. PLAIN: lower is better. FORMULA: total turnovers / games played.", "plusMinus": "WHAT: plus/minus per game. PLAIN: team point differential while he is on the floor. FORMULA: (team points - opponent points) while on court, per game. A TEAM result, not an individual one.", "fg": "WHAT: field goals made per game. FORMULA: total made field goals / games played.", "fga": "WHAT: field goals attempted per game. FORMULA: total attempts / games played.", "fgPct": "WHAT: field goal percentage. PLAIN: shots made out of shots taken. FORMULA: FGM / FGA. Treats a three the same as a layup, which is why eFG% and TS% exist.", "fg2a": "WHAT: two-point attempts per game. FORMULA: (FGA - 3PA) / games played.", "fg2Pct": "WHAT: two-point percentage. FORMULA: 2PM / 2PA.", "fg3": "WHAT: threes made per game. FORMULA: total made threes / games played.", "fg3a": "WHAT: three-point attempts per game. FORMULA: total 3PA / games played.", "fg3Pct": "WHAT: three-point percentage. FORMULA: 3PM / 3PA.", "fg3Ar": "WHAT: three-point attempt rate. PLAIN: what share of his shots are threes. FORMULA: 3PA / FGA.", "ft": "WHAT: free throws made per game. FORMULA: total FTM / games played.", "fta": "WHAT: free throws attempted per game. FORMULA: total FTA / games played.", "ftPct": "WHAT: free throw percentage. FORMULA: FTM / FTA.", "ftr": "WHAT: free throw rate. PLAIN: how often he gets to the line relative to shooting. FORMULA: FTA / FGA.", "efg": "WHAT: effective field goal percentage. PLAIN: shooting percentage that credits a three as worth more. FORMULA: (FGM + 0.5 x 3PM) / FGA.", "ts": "WHAT: true shooting percentage. PLAIN: the best single measure of scoring efficiency \\u2014 counts twos, threes and free throws together. FORMULA: PTS / (2 x (FGA + 0.44 x FTA)).", "usg": "WHAT: usage rate. PLAIN: share of team possessions he finishes while on the floor. FORMULA: estimated possessions used (shots, turnovers, trips to the line) as a percent of team possessions used while on court.", "astPct": "WHAT: assist rate. PLAIN: share of team-mate baskets he assists while on court. FORMULA: AST / (estimated team-mate field goals made while on court).", "astRatio": "WHAT: assist ratio. PLAIN: how much of what he does ends in an assist. FORMULA: AST per 100 possessions he uses.", "astTo": "WHAT: assist-to-turnover ratio. PLAIN: passes that help versus passes that cost. FORMULA: AST / TOV.", "astPer100": "WHAT: assists per 100 possessions. PLAIN: pace-neutral playmaking volume. FORMULA: AST x 100 / possessions.", "toRatio": "WHAT: turnover ratio. PLAIN: turnovers per 100 possessions used. FORMULA: TOV x 100 / possessions used. NOTE: this is NOT the same statistic as team TOV%.", "tovPer100": "WHAT: turnovers per 100 possessions. FORMULA: TOV x 100 / possessions.", "stlPer100": "WHAT: steals per 100 possessions. PLAIN: pace-neutral steal volume. FORMULA: STL x 100 / possessions.", "blkPer100": "WHAT: blocks per 100 possessions. FORMULA: BLK x 100 / possessions.", "orebPct": "WHAT: offensive rebound rate. FORMULA: share of available offensive rebounds he collects while on court.", "drebPct": "WHAT: defensive rebound rate. FORMULA: share of available defensive rebounds he collects while on court.", "rebPct": "WHAT: total rebound rate. FORMULA: share of all available rebounds he collects while on court.", "pace": "WHAT: pace. PLAIN: possessions per 48 minutes for his team while he plays. FORMULA: estimated team possessions per 48. A TEAM context number, not a skill.", "poss": "WHAT: possessions. PLAIN: how many possessions he was on the floor for. FORMULA: estimated possessions played.", "pie": "WHAT: Player Impact Estimate. PLAIN: his share of everything that happened in his games. FORMULA: his box-score contributions as a percent of both teams\\u2019 combined contributions.", "per": "WHAT: Player Efficiency Rating (Basketball-Reference). PLAIN: per-minute box-score productivity, league-average 15. NOTE: a snapshot from Basketball-Reference, not re-fetched with the rest of the database.", "ws": "WHAT: win shares. PLAIN: estimated wins credited to him. FORMULA: offensive + defensive win shares (Basketball-Reference).", "ws48": "WHAT: win shares per 48 minutes. PLAIN: rate version of win shares. FORMULA: WS / minutes x 48.", "defWs": "WHAT: defensive win shares. FORMULA: Basketball-Reference defensive win share estimate.", "bpm": "WHAT: box plus/minus. PLAIN: estimated points per 100 possessions above league average. FORMULA: Basketball-Reference regression on box-score stats.", "vorp": "WHAT: value over replacement player. FORMULA: (BPM - (-2.0)) x share of minutes played x team games / 82 (Basketball-Reference).", "grade": "WHAT: overall per-game grade, 0.0000-9.9999. PLAIN: single-number rating of season performance. FORMULA: six weighted percentile components (scoring .30, playmaking .18, rebounding .14, defense .16, efficiency .12, impact .10), shrunk toward the league mean in proportion to minutes played, then mapped onto the 0-9.9999 scale.", "gradeRaw": "WHAT: grade before shrinkage. PLAIN: what his own line alone says, with no regression to the mean. FORMULA: the weighted component score prior to the minutes-based shrinkage step.", "gradeShrunk": "WHAT: grade after shrinkage, before scaling. FORMULA: (minutes x own score + K x league prior) / (minutes + K), with K = 0.8 x median minutes.", "labScore": "WHAT: your custom Formula Lab score. PLAIN: whatever combination of metrics you built in the Lab. FORMULA: defined by your own metric weights, not by this app.", "height": "WHAT: listed height.", "weight": "WHAT: listed weight in pounds.", "jersey": "WHAT: jersey number.", "college": "WHAT: college or last team before turning pro.", "country": "WHAT: country of origin.", "birthdate": "WHAT: date of birth. Used to compute the exact age columns.", "teamCount": "WHAT: number of teams he played for this season. PLAIN: 2+ means he was traded or moved between teams.", "draftYear": "WHAT: year he was drafted.", "draftRound": "WHAT: draft round.", "draftNumber": "WHAT: overall draft pick number.", "draftStatus": "WHAT: drafted or undrafted, with the pick if drafted.", "brefScope": "WHAT: which Basketball-Reference rows this player\\u2019s snapshot covers. PLAIN: provenance for the BR-sourced columns (PER, win shares, BPM, VORP).", "components.scoring": "WHAT: scoring component of the grade (30% weight). FORMULA: weighted percentile of points, true shooting and shot creation within the league.", "components.playmaking": "WHAT: playmaking component (18% weight). FORMULA: weighted percentile of assists, assist rate and ball security.", "components.rebounding": "WHAT: rebounding component (14% weight). FORMULA: weighted percentile of offensive and defensive rebound rates.", "components.defense": "WHAT: defense component (16% weight). FORMULA: weighted percentile of steals, blocks, defensive rating and defensive rebounding.", "components.efficiency": "WHAT: efficiency component (12% weight). FORMULA: weighted percentile of true shooting and turnover economy.", "components.impact": "WHAT: impact component (10% weight). FORMULA: weighted percentile of on-court results such as PIE and net rating.", "custom.twoWayIndex": "WHAT: two-way index. PLAIN: a single number for being good at both ends. FORMULA: equal blend of offensive percentiles (offensive rating, true shooting, scoring) and defensive percentiles (defensive rating, defensive win shares per 36, steals+blocks, defensive rebound rate), averaged 50/50. PIE is deliberately excluded because it already contains defensive rebounds, steals and blocks, which made defence count on both sides.", "custom.efficiencyOverExpectedRaw": "WHAT: efficiency over expected, BEFORE shrinkage. PLAIN: the unregressed version, noisier on small samples. FORMULA: same as the adjusted column without the minutes-weighted shrinkage step.", "custom.impactOverExpectedRaw": "WHAT: impact over expected, BEFORE shrinkage. FORMULA: unregressed version of the adjusted column.", "custom.paintPts36Raw": "WHAT: paint points per 36, BEFORE shrinkage. FORMULA: unregressed version of the adjusted column.", "custom.selfCreatedPts36Raw": "WHAT: self-created points per 36, BEFORE shrinkage. FORMULA: unregressed version of the adjusted column.", "custom.situationalPts36Raw": "WHAT: situational points per 36, BEFORE shrinkage. FORMULA: unregressed version of the adjusted column."};


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

let tipEl = null, tipPinned = false;
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
    + `<div class="tip-hint">Click the header to sort \u00b7 press <b>?</b> or use "Stat guide" for every column</div>`;
  const r = th.getBoundingClientRect();
  el.classList.add('show');
  const w = el.offsetWidth, hgt = el.offsetHeight;
  let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.bottom + 8;
  if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 8);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}
function hideStatTip(){ if (tipEl && !tipPinned) tipEl.classList.remove('show'); }

/** Full browsable reference for every column the app can show. */
function openStatGuide(){
  const seen = new Map();
  for (const keys of Object.values(PRESETS)) for (const k of keys) {
    if (k === 'select' || seen.has(k)) continue;
    const d = colDef(k);
    if (d && d.help) seen.set(k, d);
  }
  const items = [...seen.entries()].sort((a,b)=>String(a[1].label).localeCompare(String(b[1].label)));
  const render = (filter) => items
    .filter(([k,d]) => !filter || (d.label+' '+k+' '+d.help).toLowerCase().includes(filter))
    .map(([k,d]) => {
      const h = parseHelp(d.help);
      const sec = (lab, v, cls) => v ? `<div class="sg-sec"><span class="sg-k">${lab}</span>${cls?`<span class="${cls}">${esc(v)}</span>`:esc(v)}</div>` : '';
      return `<div class="stat-guide-item"><h4>${esc(d.label||k)}<span class="sg-key">${esc(k)}</span></h4>`
        + sec('What it is', h.what) + sec('In plain words', h.plain)
        + sec('How it is calculated', h.formula, 'sg-formula') + sec('Note', h.note) + '</div>';
    }).join('') || '<p>No stat matches that search.</p>';
  const dlg = document.createElement('dialog');
  dlg.className = 'modal wide';
  dlg.innerHTML = `<h2>Stat guide</h2>
    <p>Every column in the database: what it is, what it shows in plain words, and how it is calculated. ${items.length} stats documented.</p>
    <input class="stat-guide-search" id="sgSearch" type="search" placeholder="Search stats, e.g. TULIP, true shooting, readiness\u2026" />
    <div class="stat-guide-list" id="sgList">${render('')}</div>
    <div class="modal-actions"><button class="button" id="sgClose">Close</button></div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.querySelector('#sgSearch').addEventListener('input', (e) => {
    dlg.querySelector('#sgList').innerHTML = render(e.target.value.trim().toLowerCase());
  });
  dlg.querySelector('#sgClose').onclick = () => dlg.close();
  dlg.addEventListener('close', () => dlg.remove());
}

function colDef(key){
  const base = BASE_COLS[key] || {label:humanize(key), type:''};
  if (base.help) return base;
  const help = COLUMN_HELP[key] || docHelp(key);
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
  fill('teamFilter','All teams',[...new Set(players.map(p=>p.team).filter(Boolean))].sort());
  fill('positionFilter','All positions',[...new Set(players.map(p=>p.positionFamily).filter(Boolean))].sort());
  fill('countryFilter','All countries',[...new Set(players.map(p=>p.country).filter(Boolean))].sort());
  const hasSplits=players.some(p=>p.showcaseGP>0);
  const hasTracking=players.some(p=>p.stats&&p.stats.trk_drives_drives!==undefined);
  const hasMonths=players.some(p=>p.stats&&Object.keys(p.stats).some(k=>/^sit_month\d+_gp$/.test(k)));
  $('viewPreset').innerHTML=Object.entries(PRESET_LABELS).filter(([k])=>
    (k!=='splits'||hasSplits)&&(k!=='tracking'||hasTracking)&&(k!=='splitsMonthly'||hasMonths)
  ).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('');
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

/** Team filtering matches any team the player actually appeared for, not just the last one. */
function playedFor(p,team){
  if(!team) return true;
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
  'tulip.verdict','tulip.targetMpg','opt.optimalMpg','opt.minutesDelta','opt.projectedAtOptimal',
  'opt.confidence','opt.supportedBands','nbaReadiness','rb.playmaking','rb.connecting','rb.defense',
  'rb.hustle','rb.shooting',
  'ts','efg','usg','astPct','astRatio','orebPct','drebPct','rebPct','toRatio','tovPct',
  'offRtg','defRtg','netRtg','pace','pie','poss','stlPer100','blkPer100','astPer100','tovPer100',
  'defWs','per','ows','dws','ws','ws48','obpm','dbpm','bpm','vorp','stlPct','blkPct',
  'wsPerGame','dwsPerGame','vorpPerGame','oreb','dreb','fg','fga','fg3','fg3a','fg2','fg2a',
  'ft','fta','tov','pf','pfd','blka','dd2','td3','fg2Pct','fg3Ar','ftr','astTo',
  'wins','losses','regularGP','showcaseGP','teamCount'];

function teamScoped(p,team,mode){
  if(!team||mode!=='only') return p;
  if((p.teamCount||1)<=1) return p;
  const stint=(p.teams||[]).find(s=>s.team===team);
  if(!stint) return p;
  const q={...p, team:stint.team, teamScopedTo:team, seasonGp:p.gp, seasonGrade:p.grade};
  for(const [dest,src] of Object.entries(STINT_FIELDS)) q[dest]=stint[src];
  for(const k of SEASON_ONLY) q[k]=null;
  q.custom={}; q.components={}; q.rateComponents={};
  // Raw source fields are season-scoped with no stint equivalent.
  q.stats={};
  return q;
}

function filteredPlayers(){
  const q=fold($('searchInput').value.trim());
  const team=$('teamFilter').value, pos=$('positionFilter').value, country=$('countryFilter').value;
  const minGp=Number($('minGp').value)||0, minMpg=Number($('minMpg').value)||0;
  const minMin=Number($('minMin').value)||0, minGrade=Number($('minGrade').value)||0;
  const minRel=Number($('minReliability').value)||0;
  const teamMode=$('teamMode')?.value||'season';
  const showRosterOnly=$('includeRosterOnly')?.checked;
  let list=currentPlayers()
    .filter(p=>{
      if(p.rosterOnly&&!showRosterOnly) return false;
      const hay=fold([p.name,p.team,p.position,p.country,p.college,...(p.teams||[]).map(s=>s.team)].filter(Boolean).join(' '));
      return (!q||hay.includes(q))&&playedFor(p,team)&&(!pos||positionMatches(p,pos))&&(!country||p.country===country)
        &&(!$('bothOnly').checked||p.bothLeagues);
    })
    // Scope BEFORE the numeric filters, so thresholds apply to the line actually displayed.
    .map(p=>teamScoped(p,team,teamMode))
    .filter(p=>{
      const gradeOk=p.grade===null?(showRosterOnly||p.teamScopedTo):p.grade>=minGrade;
      return p.gp>=minGp&&(p.mpg||0)>=minMpg&&(p.minutes||0)>=minMin&&gradeOk
        &&(p.teamScopedTo||(p.reliabilityWeight||0)>=minRel)&&applyRules(p);
    });
  list.sort((a,b)=>{
    const av=get(a,sortKey),bv=get(b,sortKey);
    if(finite(av)&&finite(bv))return (Number(av)-Number(bv))*sortDir;
    if(finite(av))return -1;if(finite(bv))return 1;
    return String(av??'').localeCompare(String(bv??''))*sortDir;
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
  const sortable=cols.filter(k=>k!=='select');
  const sig=sortable.join('|');
  if(sel.dataset.sig!==sig){
    sel.dataset.sig=sig;
    sel.innerHTML=sortable.map(k=>`<option value="${esc(k)}">${esc(colDef(k).label)}</option>`).join('');
  }
  // If the active sort column is not in this view (e.g. after switching preset), fall back to the
  // first sortable column rather than showing a selection that does not exist.
  if(!sortable.includes(sortKey)) sortKey = sortable.includes('grade') ? 'grade' : sortable[0];
  sel.value=sortKey;
  const ord=$('sortOrder'); if(ord) ord.value=String(sortDir);
}

function renderSummary(list){
  const all=currentPlayers();
  const filtered=list.length!==all.length;
  const best=[...list].sort((a,b)=>b.grade-a.grade)[0];
  const cards=[
    [filtered?'Players (filtered)':'Players',`${list.length.toLocaleString()}${filtered?` of ${all.length.toLocaleString()}`:''}`],
    [filtered?'Top of selection':'Top player',best?.name||'—'],
    ['Median MPG',num(median(list.map(x=>x.mpg)),1)],
    ['Median GP',num(median(list.map(x=>x.gp)),0)],
    ['Played both leagues',list.filter(x=>x.bothLeagues).length.toLocaleString()],
    ['Fields available',String(new Set(all.flatMap(x=>Object.keys(x.stats||{}))).size)]
  ];
  $('summaryGrid').innerHTML=cards.map(([l,v])=>`<div class="summary-card"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div></div>`).join('');
}

function renderRules(){
  $('activeRules').innerHTML=rules.map((r,i)=>`<div class="rule-chip">${esc(colDef(r.key).label)} ${esc(r.op)} ${esc(r.value)}${isFraction(r.key)?'%':''} <button data-rule-remove="${i}">×</button></div>`).join('');
  document.querySelectorAll('[data-rule-remove]').forEach(b=>b.onclick=()=>{rules.splice(Number(b.dataset.ruleRemove),1);render();});
}

function render(){
  const cols=visibleColumns(), list=filteredPlayers();
  let limit=Number($('rowLimit').value)||50;
  viewRankOf=new Map(list.map((p,i)=>[p.playerId,i+1]));
  // A wide view times the row count gives the real cost. All Raw Stats at 1,075 columns x 582
  // rows is 625,000 cells and took 6.1s to lay out, so very wide views cap their rows and say so.
  const CELL_BUDGET=120000;
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
  $('sortLabel').textContent=`· sorted by ${colDef(sortKey).label} ${sortDir<0?'↓':'↑'}`
    +(scoped?` · ${scoped} multi-team ${scoped===1?'player is':'players are'} showing ${$('teamFilter').value}-only stint lines`:'');
  syncSortControls(cols);
  $('tableHead').innerHTML=cols.map(key=>{
    const d=colDef(key);
    const hasTip = !!d.help;
    // tabindex + role make the header a real control: it can be reached by keyboard, which is
    // also what makes the focus-triggered explainer panel reachable without a mouse. aria-sort
    // announces the current ordering to screen readers.
    const aria = sortKey===key ? (sortDir<0?'descending':'ascending') : 'none';
    return `<th class="${key==='name'?'left':''}${hasTip?' has-tip':''}" data-sort="${esc(key)}" tabindex="0" role="columnheader" aria-sort="${aria}" title="${esc(d.help||d.label)}">${esc(d.label)}${sortKey===key?(sortDir<0?' ↓':' ↑'):''}</th>`;
  }).join('');
  $('tableBody').innerHTML=shown.map(p=>`<tr>${cols.map(key=>cell(p,key)).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="loading">No players match these filters.</td></tr>`;
  document.querySelectorAll('[data-sort]').forEach(th=>{
    th.onclick=()=>{const k=th.dataset.sort;if(sortKey===k)sortDir*=-1;else{sortKey=k;sortDir=-1}render();};
    // The native title tooltip is kept in the DOM for screen readers and for the regression test,
    // but stripped while the pointer is over the header so the browser's own box does not appear
    // on top of the styled panel.
    th.addEventListener('mouseenter',()=>{ th.dataset.title=th.getAttribute('title')||''; th.removeAttribute('title'); showStatTip(th, th.dataset.sort); });
    th.addEventListener('mouseleave',()=>{ if(th.dataset.title!==undefined) th.setAttribute('title', th.dataset.title); hideStatTip(); });
    th.addEventListener('focus',()=>showStatTip(th, th.dataset.sort));
    th.addEventListener('blur',hideStatTip);
    th.addEventListener('keydown',(e)=>{
      if(e.key!=='Enter'&&e.key!==' ') return;
      e.preventDefault(); th.click();
    });
  });
  document.querySelectorAll('[data-player]').forEach(b=>b.onclick=()=>openPlayer(b.dataset.player));
  document.querySelectorAll('[data-profile]').forEach(b=>b.onclick=()=>window.__wsOpenPlayer?.(b.dataset.profile));
  document.querySelectorAll('[data-compare]').forEach(c=>c.onchange=()=>{if(c.checked){if(compared.size>=5){c.checked=false;return}compared.add(c.dataset.compare)}else compared.delete(c.dataset.compare);updateCompare();});
  renderRules(); renderSummary(list); updateCompare();
}

function cell(p,key){
  const def=colDef(key),v=get(p,key);
  if(key==='select')return `<td><input class="compare-check" type="checkbox" data-compare="${esc(p.playerId)}" ${compared.has(p.playerId)?'checked':''}></td>`;
  if(key==='name'){
    const multi=(p.teamCount||1)>1?`<span class="multi-badge" title="${esc((p.teams||[]).map(s=>`${s.team} ${s.gp}g`).join(' · '))}">${p.teamCount} TM</span>`:'';
    return `<td class="left player-cell"><button class="player-link" data-player="${esc(p.playerId)}">${esc(p.name)}</button>${window.__wsOpenPlayer?`<button class="profile-link" data-profile="${esc(p.playerId)}" title="Open full profile">↗</button>`:''}${p.bothLeagues?'<span class="both-badge">NBA ↔ G</span>':''}${multi}<span class="tiny">${esc(p.team||'')} · ${esc(p.position||'—')}</span></td>`;
  }
  if(key==='grade')return `<td class="grade ${gradeClass(v)}">${fmt(v,def.type)}</td>`;
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

function openPlayer(id){
  const p=displayedRow(id); if(!p)return;

  // Roster-only players have no performance to show. grade is null by design, so the normal
  // hero would throw on p.grade.toFixed(4).
  if(p.rosterOnly){
    $('playerDialogBody').innerHTML=`<div class="player-hero"><div>
        <div class="eyebrow">${esc(p.leagueLabel)} · NO APPEARANCE</div>
        <h2>${esc(p.name)}</h2>
        <p>${esc(p.team||'—')} · ${esc(p.position||'—')} · ${p.age??'—'} yrs · ${esc(p.height||'—')}</p>
        <p class="tiny">On a 2025-26 roster but never played a game.</p></div></div>
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

  $('playerDialogBody').innerHTML=`<div class="player-hero"><div><div class="eyebrow">${esc(p.leagueLabel)}${finite(p.rank)?` · RANK #${p.rank} of ${DATA.counts[p.league]}`:''}</div>
      <h2>${esc(p.name)}</h2>${scopeNote}
      <p>${esc(p.team)} · ${esc(p.position||'—')} · ${p.age??'—'} yrs · ${esc(p.height||'—')} · ${p.weight?p.weight+' lb':'—'} · ${esc(p.country||'—')}</p>
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
      ${p.cohortRanks?.team?`<div class="detail-card"><div class="k">On ${esc(p.team)}</div><div class="v">#${p.cohortRanks.team.rank} <span class="tiny">of ${p.cohortRanks.team.of}</span></div></div>`:''}
      ${p.cohortRanks?.ageGroup?`<div class="detail-card"><div class="k">${(p.ageOpeningNight??p.age)<=23?'Age 23 and under':'Age 24+'} <span class="tiny">on opening night</span></div><div class="v">#${p.cohortRanks.ageGroup.rank} <span class="tiny">of ${p.cohortRanks.ageGroup.of}</span></div></div>`:''}
      ${customCards}
    </div>${stints}${crossover}
    <h3>All retained source fields</h3>${raw}`;
  $('playerDialog').showModal();
}

function openCompare(){
  // Compare the rows as displayed, so team-only mode is not silently undone here either.
  const ps=[...compared].map(id=>displayedRow(id)).filter(Boolean);
  const scoped=ps.filter(p=>p.teamScopedTo);
  const rows=['rank','grade','gp','mpg','pts','reb','ast','stl','blk','tov','ts','efg','usg','astPct','rebPct',
    'offRtg','defRtg','netRtg','pie','per','ws48','bpm','vorp',...CUSTOM_KEYS];
  $('compareDialogBody').innerHTML=`<h2>Player comparison</h2>`
    +(scoped.length?`<p class="tiny">${scoped.map(p=>esc(p.name)+' — '+esc(p.teamScopedTo)+' stint only').join(' · ')}</p>`:'')
    +`<div class="table-wrap"><table class="compare-table"><thead><tr><th class="left">Metric</th>${ps.map(p=>`<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>${
    rows.filter(k=>ps.some(p=>finite(get(p,k)))).map(k=>`<tr><td class="left">${esc(colDef(k).label)}</td>${ps.map(p=>`<td>${fmt(get(p,k),colDef(k).type)}</td>`).join('')}</tr>`).join('')
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
    <input id="catalogSearch" type="search" placeholder="Search fields…" />
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
  const base=`${league.toLowerCase()}_2025-26_rankings`;

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
}

function bind(){
  document.querySelectorAll('.league-tab').forEach(b=>b.onclick=()=>switchLeague(b));
  ['searchInput','teamFilter','teamMode','positionFilter','countryFilter','minGp','minMpg','minMin','minGrade','minReliability','bothOnly','includeRosterOnly','viewPreset','rowLimit']
    .forEach(id=>$(id).addEventListener(id==='searchInput'?'input':'change',render));
  // Sort controls must SET the sort state, not merely re-render, so they get explicit handlers
  // rather than joining the generic list above.
  $('sortField').addEventListener('change',()=>{sortKey=$('sortField').value;render();});
  $('sortOrder').addEventListener('change',()=>{sortDir=Number($('sortOrder').value)||-1;render();});
  $('resetBtn').onclick=reset;$('exportBtn').onclick=exportCsv;$('aboutBtn').onclick=openMetricDefinitions;$('applyLab').onclick=applyLab;
  $('catalogBtn').onclick=openFieldCatalog;
  $('statGuideBtn').onclick=openStatGuide;
  // "?" opens the guide from anywhere, unless the user is typing in a field.
  document.addEventListener('keydown',(e)=>{
    if(e.key!=='?'||e.metaKey||e.ctrlKey) return;
    const t=e.target.tagName;
    if(t==='INPUT'||t==='SELECT'||t==='TEXTAREA') return;
    e.preventDefault(); openStatGuide();
  });
  $('compareBtn').onclick=openCompare;$('clearCompareBtn').onclick=()=>{compared.clear();render()};
  $('addRuleBtn').onclick=()=>{
    $('ruleUnitHint').textContent='';
    $('ruleDialog').showModal();
  };
  $('ruleMetric').onchange=()=>{
    const k=$('ruleMetric').value;
    $('ruleUnitHint').textContent=isFraction(k)?'Enter percentage points, e.g. 60 for 60%':'';
  };
  $('saveRuleBtn').onclick=()=>{rules.push({key:$('ruleMetric').value,op:$('ruleOp').value,value:Number($('ruleValue').value)});$('ruleDialog').close();render();};
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
}

// Bridge for workspace.js so it does not duplicate formatting, filtering or label logic.
window.__wsLeague=()=>league;
window.__wsRender=()=>render();
window.__wsFiltered=()=>filteredPlayers();
window.__wsCompared=()=>[...compared];
window.__wsLabel=(k)=>colDef(k).label;
window.__wsFmt=(v,k)=>fmt(v,colDef(k).type);

async function init(){
  try{
    const r=await fetch('./public/data.json',{cache:'no-store'}); if(!r.ok)throw new Error(`data.json returned ${r.status}`); DATA=await r.json();
    DATA=rehydrate(DATA);
    // `let DATA` at script scope is NOT a window property, so workspace.js could not see it.
    window.DATA=DATA;
    $('nbaCount').textContent=DATA.counts.NBA.toLocaleString();$('gCount').textContent=DATA.counts.GLEAGUE.toLocaleString();
    const ro=(DATA.counts.rosterOnlyNBA||0)+(DATA.counts.rosterOnlyGLEAGUE||0);
    $('sourceLine').textContent=`${DATA.primarySource} · ${DATA.counts.records} league-season records for ${DATA.counts.uniquePeople} unique players`
      +(ro?`, plus ${ro} rostered who never played`:'')+` · generated ${new Date(DATA.generatedAt).toLocaleString()}`;
    $('seasonEyebrow').textContent=DATA.seasonType;
    populateSelectors();fillMetricSelects();bind();render();
    if(window.__wsInit) window.__wsInit();
    if(window.claude && !(await capability('downloads'))) $('exportBtn').hidden=true;
  }catch(e){
    $('sourceLine').textContent='The data build has not completed yet.';
    $('tableBody').innerHTML=`<tr><td class="error">${esc(e.message)}. Run <code>npm run build</code> to generate public/data.json.</td></tr>`;
  }
}
init();
