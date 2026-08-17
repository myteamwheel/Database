const $ = id => document.getElementById(id);
let DATA = null;
let league = 'NBA';
let sortKey = 'grade';
let sortDir = -1;
let rules = [];
let compared = new Set();
let labConfig = [];

const get = (p, key) => {
  if (key === 'labScore') return p.labScore ?? null;
  if (key.startsWith('stats.')) return p.stats?.[key.slice(6)] ?? null;
  if (key.startsWith('custom.')) return p.custom?.[key.slice(7)] ?? null;
  if (key.startsWith('components.')) return p.components?.[key.slice(11)] ?? null;
  return p[key] ?? null;
};
const finite = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = v => finite(v) ? `${(Number(v)*100).toFixed(1)}%` : '—';
const pctPoints = v => finite(v) ? `${Number(v).toFixed(1)}%` : '—';
const num = (v,d=1) => finite(v) ? Number(v).toFixed(d) : '—';
const signed = (v,d=1) => finite(v) ? (Number(v)>0?'+':'')+Number(v).toFixed(d) : '—';
const median = vals => { const a=vals.filter(finite).map(Number).sort((x,y)=>x-y); if(!a.length)return null; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };

const SRC_LABEL = {off:'Official',oadv:'Official Adv',omisc:'Official Misc',oscore:'Official Scoring',
  ousage:'Official Usage',odef:'Official Def',obio:'Bio',bref:'Bref',hustle:'Hustle',trk:'Tracking',
  split:'Split'};
const humanize = key => {
  const k = key.replace(/^stats\./,'').replace(/^custom\./,'').replace(/^components\./,'');
  const m = k.match(/^(off|oadv|omisc|oscore|ousage|odef|obio|bref|hustle|trk|split)_(.+)$/);
  const body = (m?m[2]:k).replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
  return m ? `${SRC_LABEL[m[1]]} · ${body}` : body.replace(/\b\w/g,c=>c.toUpperCase());
};

const BASE_COLS = {
  select:{label:'',type:'select'}, rank:{label:'#',type:'int'}, name:{label:'Player',type:'player'},
  team:{label:'Team',type:'text'}, position:{label:'Pos',type:'text'}, positionSource:{label:'Pos src',type:'text'},
  age:{label:'Age',type:'int'}, height:{label:'Ht',type:'text'}, heightInches:{label:'Ht (in)',type:'int'},
  weight:{label:'Wt',type:'int'}, college:{label:'College',type:'text'}, country:{label:'Country',type:'text'},
  jersey:{label:'#Jsy',type:'text'}, draftYear:{label:'Draft Yr',type:'text'}, draftRound:{label:'Rd',type:'text'},
  draftNumber:{label:'Pick',type:'text'},
  gp:{label:'GP',type:'int'}, gs:{label:'GS',type:'int'}, wins:{label:'W',type:'int'}, losses:{label:'L',type:'int'},
  regularGP:{label:'RS GP',type:'int'}, showcaseGP:{label:'Cup GP',type:'int'},
  mpg:{label:'MIN',type:'1'}, minutes:{label:'Total MIN',type:'int'},
  grade:{label:'Grade',type:'grade'}, gradeRaw:{label:'Raw Score',type:'2'}, gradeShrunk:{label:'Shrunk Score',type:'2'},
  sampleConfidence:{label:'Confidence',type:'1'},
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
  seasonAge:{label:'Season Age',type:'int'},
  'stats.oscore_pct_pts_paint':{label:'% Pts Paint',type:'pct'},
  'stats.oscore_pct_pts_3pt':{label:'% Pts 3PT',type:'pct'},
  'stats.oscore_pct_pts_2pt_mr':{label:'% Pts Mid',type:'pct'},
  'stats.oscore_pct_pts_ft':{label:'% Pts FT',type:'pct'},
  'stats.oscore_pct_pts_fb':{label:'% Pts FB',type:'pct'},
  'stats.oscore_pct_uast_fgm':{label:'% FG Unast',type:'pct'},
  'stats.omisc_pts_paint':{label:'Paint Pts',type:'1'},
  'stats.omisc_pts_fb':{label:'FB Pts',type:'1'},
  'stats.omisc_pts_off_tov':{label:'Pts off TO',type:'1'},
  'stats.omisc_pts_2nd_chance':{label:'2nd Chance',type:'1'},
  offRtg:{label:'OffRtg',type:'1'}, defRtg:{label:'DefRtg',type:'1'}, netRtg:{label:'NetRtg',type:'signed1'},
  pace:{label:'Pace',type:'1'}, pie:{label:'PIE',type:'pct'}, poss:{label:'Poss',type:'int'},
  stlPer100:{label:'STL/100',type:'2'}, blkPer100:{label:'BLK/100',type:'2'},
  astPer100:{label:'AST/100',type:'2'}, tovPer100:{label:'TOV/100',type:'2'}, defWs:{label:'DEF WS',type:'2'},
  per:{label:'PER',type:'2'}, ows:{label:'OWS',type:'2'}, dws:{label:'DWS',type:'2'}, ws:{label:'WS',type:'2'},
  ws48:{label:'WS/48',type:'3'}, obpm:{label:'OBPM',type:'2'}, dbpm:{label:'DBPM',type:'2'},
  bpm:{label:'BPM',type:'2'}, vorp:{label:'VORP',type:'2'},
  stlPct:{label:'STL%',type:'pctPoints'}, blkPct:{label:'BLK%',type:'pctPoints'},
  wsPerGame:{label:'WS/G',type:'3'}, dwsPerGame:{label:'DWS/G',type:'3'}, vorpPerGame:{label:'VORP/G',type:'3'},
  'custom.selfCreatedPts36':{label:'Self-Created P36',type:'2'},
  'custom.chaosPts36':{label:'Chaos Pts36',type:'2'},
  'custom.possessionSwing36':{label:'Poss Swing36',type:'signed2'},
  'custom.whistleDiff36':{label:'Whistle Diff36',type:'signed2'},
  'custom.disruptionPerFoul':{label:'Disrupt/Foul',type:'3'},
  'custom.creationLoad36':{label:'Creation Load36',type:'2'},
  'custom.paintPts36':{label:'Paint Pts36',type:'2'},
  'custom.efficiencyOverExpected':{label:'Eff Over Exp',type:'signed2'},
  'custom.shotDietIndex':{label:'Shot Diet',type:'1'},
  'custom.versatilityIndex':{label:'Versatility',type:'1'},
  'custom.twoWayIndex':{label:'Two-Way',type:'1'},
  'custom.selfSufficiencyIndex':{label:'Self-Sufficiency',type:'1'},
  'custom.defensiveDisruptionIndex':{label:'Def Disruption',type:'1'},
  'custom.roleAdjustedImpact':{label:'Role-Adj Impact',type:'2'},
  'components.scoring':{label:'Scoring Comp',type:'1'}, 'components.playmaking':{label:'Playmaking Comp',type:'1'},
  'components.rebounding':{label:'Rebound Comp',type:'1'}, 'components.defense':{label:'Defense Comp',type:'1'},
  'components.efficiency':{label:'Efficiency Comp',type:'1'}, 'components.impact':{label:'Impact Comp',type:'1'},
  labScore:{label:'Lab Score',type:'1'}
};

const CUSTOM_KEYS = ['custom.selfCreatedPts36','custom.chaosPts36','custom.possessionSwing36','custom.whistleDiff36',
  'custom.disruptionPerFoul','custom.creationLoad36','custom.paintPts36','custom.efficiencyOverExpected',
  'custom.shotDietIndex','custom.versatilityIndex','custom.twoWayIndex','custom.selfSufficiencyIndex',
  'custom.defensiveDisruptionIndex','custom.roleAdjustedImpact'];

const PRESETS = {
  overall:['select','rank','name','team','position','age','gp','mpg','grade','pts','reb','ast','stl','blk','ts','usg','pie','netRtg','custom.twoWayIndex','sampleConfidence'],
  scoring:['select','rank','name','team','grade','pts','fg','fga','fgPct','fg3','fg3a','fg3Pct','ft','fta','ftPct','efg','ts','fg3Ar','ftr','usg','custom.selfCreatedPts36','custom.paintPts36','custom.efficiencyOverExpected'],
  shooting:['select','rank','name','team','grade','fga','fgPct','fg3a','fg3Pct','fg2a','fg2Pct','ftPct','efg','ts','custom.efficiencyOverExpected','custom.shotDietIndex','stats.trk_catchshoot_catch_shoot_pts','stats.trk_catchshoot_catch_shoot_fga','stats.trk_pullup_pull_up_pts','stats.trk_pullup_pull_up_fga'],
  playmaking:['select','rank','name','team','grade','ast','tov','astPct','astRatio','astTo','astPer100','tovPer100','toRatio','usg','custom.creationLoad36','custom.selfSufficiencyIndex'],
  rebounding:['select','rank','name','team','grade','oreb','dreb','reb','orebPct','drebPct','rebPct','custom.possessionSwing36'],
  defense:['select','rank','name','team','grade','stl','blk','dreb','stlPer100','blkPer100','drebPct','defRtg','defWs','custom.defensiveDisruptionIndex','custom.disruptionPerFoul','custom.possessionSwing36'],
  impact:['select','rank','name','team','grade','mpg','offRtg','defRtg','netRtg','pie','plusMinus','poss','pace','per','ws','ws48','bpm','vorp','custom.roleAdjustedImpact','custom.twoWayIndex'],
  shotprofile:['select','rank','name','team','grade','pts','custom.shotDietIndex','custom.paintPts36','custom.chaosPts36','stats.oscore_pct_pts_paint','stats.oscore_pct_pts_3pt','stats.oscore_pct_pts_2pt_mr','stats.oscore_pct_pts_ft','stats.oscore_pct_pts_fb','stats.oscore_pct_uast_fgm','stats.omisc_pts_paint','stats.omisc_pts_fb','stats.omisc_pts_off_tov','stats.omisc_pts_2nd_chance'],
  custom:['select','rank','name','team','grade',...CUSTOM_KEYS,'labScore'],
  components:['select','rank','name','team','grade','gradeRaw','gradeShrunk','sampleConfidence','components.scoring','components.playmaking','components.rebounding','components.defense','components.efficiency','components.impact'],
  bio:['select','rank','name','team','position','positionSource','age','height','weight','country','college','draftYear','draftRound','draftNumber','jersey','gp','mpg','grade'],
  splits:['select','rank','name','team','grade','gp','regularGP','showcaseGP','minutes','mpg','pts','reb','ast','stats.split_reg_gp','stats.split_reg_min','stats.split_reg_pts','stats.split_showcase_gp','stats.split_showcase_min','stats.split_showcase_pts'],
  tracking:['select','rank','name','team','grade','stats.trk_drives_drives','stats.trk_drives_drive_pts','stats.trk_passing_passes_made','stats.trk_passing_potential_ast','stats.trk_passing_ast_points_created','stats.trk_touches_touches','stats.trk_touches_time_of_poss','stats.trk_touches_paint_touches','stats.trk_rebounding_reb_contest_pct','stats.trk_defense_def_rim_fg_pct','stats.hustle_contested_shots','stats.hustle_deflections','stats.hustle_charges_drawn','stats.hustle_screen_assists','stats.hustle_loose_balls_recovered','stats.hustle_box_outs'],
};

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
for (const [k,label] of Object.entries(TRACK_LABELS)) {
  BASE_COLS[k] = {label, type: k.endsWith('_pct') ? 'pct' : '1'};
}

// Half-season split totals read as counts, not rates.
for (const [k,label] of Object.entries({
  'stats.split_reg_gp':'RS Games','stats.split_reg_pts':'RS Pts','stats.split_reg_min':'RS Min',
  'stats.split_reg_reb':'RS Reb','stats.split_reg_ast':'RS Ast',
  'stats.split_showcase_gp':'Cup Games','stats.split_showcase_pts':'Cup Pts',
  'stats.split_showcase_min':'Cup Min','stats.split_showcase_reb':'Cup Reb','stats.split_showcase_ast':'Cup Ast',
})) BASE_COLS[k] = {label, type:'int'};

const PRESET_LABELS = {overall:'Overall',scoring:'Scoring',shooting:'Shooting',playmaking:'Playmaking',
  rebounding:'Rebounding',defense:'Defense',impact:'Impact & Ratings',shotprofile:'Shot Profile',
  custom:'Custom Metrics',components:'Grade Components',bio:'Bio & Draft',
  splits:'Season Splits (G League)',tracking:'Tracking & Hustle (NBA)',all:'All Raw Stats'};

const CORE_REGISTRY = ['grade','gradeRaw','gradeShrunk','sampleConfidence','gp','mpg','minutes','pts','reb','oreb','dreb',
  'ast','stl','blk','blka','tov','pf','pfd','plusMinus','fga','fgPct','fg3a','fg3Pct','fta','ftPct','efg','ts','fg3Ar','ftr',
  'astTo','usg','astPct','astRatio','orebPct','drebPct','rebPct','toRatio','tovPct','offRtg','defRtg','netRtg','pace','pie','poss',
  'stlPer100','blkPer100','astPer100','tovPer100','defWs','per','ows','dws','ws','ws48','obpm','dbpm','bpm','vorp',
  'stlPct','blkPct','wsPerGame','dwsPerGame','vorpPerGame','age','heightInches','weight',
  ...CUSTOM_KEYS,
  'components.scoring','components.playmaking','components.rebounding','components.defense','components.efficiency','components.impact'];

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

function gradeClass(v){return v>=8.5?'elite':v>=6.5?'strong':v>=4?'mid':'low'}
function currentPlayers(){return DATA?.leagues?.[league] || []}

function rawMetricKeys(){
  const keys=new Set();
  for(const p of currentPlayers()) for(const [k,v] of Object.entries(p.stats||{})) if(finite(v)) keys.add(`stats.${k}`);
  return [...keys].sort();
}
function metricRegistryKeys(){
  const present=new Set();
  for(const p of currentPlayers().slice(0,50)) for(const k of CORE_REGISTRY) if(finite(get(p,k))) present.add(k);
  return [...present, ...rawMetricKeys()];
}
function allRawColumns(){
  const keys=new Set();
  for(const p of currentPlayers()) Object.keys(p.stats||{}).forEach(k=>keys.add(k));
  return ['select','rank','name','team','position','grade',...Array.from(keys).sort().map(k=>`stats.${k}`),'sampleConfidence'];
}
function visibleColumns(){
  const preset=$('viewPreset').value;
  let cols=preset==='all'?allRawColumns():[...(PRESETS[preset]||PRESETS.overall)];
  // Drop columns that are empty for this league (e.g. tracking in the G League).
  if(preset!=='all'){
    const players=currentPlayers();
    cols=cols.filter(k=>{
      if(!k.startsWith('stats.')&&!['gs','per','ws','ws48','bpm','vorp','regularGP','showcaseGP'].includes(k)) return true;
      return players.some(p=>finite(get(p,k)));
    });
  }
  if(labConfig.length && !cols.includes('labScore')) cols.push('labScore');
  return cols;
}
function colDef(key){return BASE_COLS[key]||{label:humanize(key),type:''}}

function populateSelectors(){
  const players=currentPlayers();
  const teams=[...new Set(players.map(p=>p.team).filter(Boolean))].sort();
  const positions=[...new Set(players.map(p=>p.position).filter(Boolean))].sort();
  const countries=[...new Set(players.map(p=>p.country).filter(Boolean))].sort();
  $('teamFilter').innerHTML='<option value="">All teams</option>'+teams.map(x=>`<option>${esc(x)}</option>`).join('');
  $('positionFilter').innerHTML='<option value="">All positions</option>'+positions.map(x=>`<option>${esc(x)}</option>`).join('');
  $('countryFilter').innerHTML='<option value="">All countries</option>'+countries.map(x=>`<option>${esc(x)}</option>`).join('');
  const hasSplits=players.some(p=>p.showcaseGP>0);
  const hasTracking=players.some(p=>p.stats&&p.stats.trk_drives_drives!==undefined);
  $('viewPreset').innerHTML=Object.entries(PRESET_LABELS).filter(([k])=>
    (k!=='splits'||hasSplits)&&(k!=='tracking'||hasTracking)
  ).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('');
}

function applyRules(p){
  return rules.every(r=>{
    const raw=get(p,r.key); if(!finite(raw))return false;
    const v=Number(raw),t=Number(r.value); return r.op==='>='?v>=t:r.op==='<='?v<=t:r.op==='>'?v>t:v<t;
  });
}

function filteredPlayers(){
  const q=$('searchInput').value.trim().toLowerCase();
  const team=$('teamFilter').value, pos=$('positionFilter').value, country=$('countryFilter').value;
  const minGp=Number($('minGp').value)||0, minMpg=Number($('minMpg').value)||0;
  const minMin=Number($('minMin').value)||0, minGrade=Number($('minGrade').value)||0;
  let list=currentPlayers().filter(p=>{
    const hay=[p.name,p.team,p.position,p.country,p.college].filter(Boolean).join(' ').toLowerCase();
    return (!q||hay.includes(q))&&(!team||p.team===team)&&(!pos||p.position===pos)&&(!country||p.country===country)
      &&p.gp>=minGp&&(p.mpg||0)>=minMpg&&(p.minutes||0)>=minMin&&p.grade>=minGrade
      &&(!$('bothOnly').checked||p.bothLeagues)
      &&(!$('confidenceOnly').checked||p.sampleConfidence>=70)&&applyRules(p);
  });
  list.sort((a,b)=>{
    const av=get(a,sortKey),bv=get(b,sortKey);
    if(finite(av)&&finite(bv))return (Number(av)-Number(bv))*sortDir;
    if(finite(av))return -1;if(finite(bv))return 1;
    return String(av??'').localeCompare(String(bv??''))*sortDir;
  });
  return list;
}

function renderSummary(){
  const p=currentPlayers();
  const best=[...p].sort((a,b)=>b.grade-a.grade)[0];
  const cards=[
    ['Players',p.length.toLocaleString()],
    ['Top player',best?.name||'—'],
    ['Median MPG',num(median(p.map(x=>x.mpg)),1)],
    ['Median GP',num(median(p.map(x=>x.gp)),0)],
    ['Played both leagues',p.filter(x=>x.bothLeagues).length.toLocaleString()],
    ['Stat fields / player',String(new Set(p.flatMap(x=>Object.keys(x.stats||{}))).size)]
  ];
  $('summaryGrid').innerHTML=cards.map(([l,v])=>`<div class="summary-card"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div></div>`).join('');
}

function renderRules(){
  $('activeRules').innerHTML=rules.map((r,i)=>`<div class="rule-chip">${esc(colDef(r.key).label)} ${esc(r.op)} ${esc(r.value)} <button data-rule-remove="${i}">×</button></div>`).join('');
  document.querySelectorAll('[data-rule-remove]').forEach(b=>b.onclick=()=>{rules.splice(Number(b.dataset.ruleRemove),1);render();});
}

function render(){
  const cols=visibleColumns(), list=filteredPlayers(), limit=Number($('rowLimit').value)||50, shown=list.slice(0,limit);
  $('resultCount').textContent=list.length.toLocaleString();
  $('sortLabel').textContent=`· sorted by ${colDef(sortKey).label} ${sortDir<0?'↓':'↑'}`;
  $('tableHead').innerHTML=cols.map(key=>`<th class="${key==='name'?'left':''}" data-sort="${esc(key)}" title="${esc(colDef(key).label)}">${esc(colDef(key).label)}${sortKey===key?(sortDir<0?' ↓':' ↑'):''}</th>`).join('');
  $('tableBody').innerHTML=shown.map(p=>`<tr>${cols.map(key=>cell(p,key)).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="loading">No players match these filters.</td></tr>`;
  document.querySelectorAll('[data-sort]').forEach(th=>th.onclick=()=>{const k=th.dataset.sort;if(sortKey===k)sortDir*=-1;else{sortKey=k;sortDir=-1}render();});
  document.querySelectorAll('[data-player]').forEach(b=>b.onclick=()=>openPlayer(b.dataset.player));
  document.querySelectorAll('[data-compare]').forEach(c=>c.onchange=()=>{if(c.checked){if(compared.size>=5){c.checked=false;return}compared.add(c.dataset.compare)}else compared.delete(c.dataset.compare);updateCompare();});
  renderRules(); updateCompare();
}

function cell(p,key){
  const def=colDef(key),v=get(p,key);
  if(key==='select')return `<td><input class="compare-check" type="checkbox" data-compare="${esc(p.playerId)}" ${compared.has(p.playerId)?'checked':''}></td>`;
  if(key==='name')return `<td class="left player-cell"><button class="player-link" data-player="${esc(p.playerId)}">${esc(p.name)}</button>${p.bothLeagues?'<span class="both-badge">NBA ↔ G</span>':''}<span class="tiny">${esc(p.team||'')} · ${esc(p.position||'—')}</span></td>`;
  if(key==='grade')return `<td class="grade ${gradeClass(v)}">${fmt(v,def.type)}</td>`;
  return `<td class="${key==='rank'?'rank':''}">${fmt(v,def.type)}</td>`;
}

function updateCompare(){
  $('compareCount').textContent=compared.size;
  $('compareBtn').disabled=compared.size<2;
}

/** The other league's record for the same person, if they played in both. */
function counterpart(p){
  const other=league==='NBA'?'GLEAGUE':'NBA';
  return (DATA.leagues[other]||[]).find(x=>x.nbaPersonId===p.nbaPersonId)||null;
}

function openPlayer(id){
  const p=currentPlayers().find(x=>x.playerId===id); if(!p)return;
  const c=counterpart(p);
  const line=x=>`${num(x.pts)} / ${num(x.reb)} / ${num(x.ast)}`;
  const crossover=c?`<div class="crossover">
      <div class="eyebrow">SAME PLAYER, OTHER LEAGUE</div>
      <table class="compare-table"><thead><tr><th class="left">Metric</th><th>${esc(p.leagueLabel)}</th><th>${esc(c.leagueLabel)}</th></tr></thead>
      <tbody>${[['Rank','rank'],['Grade','grade'],['Games','gp'],['MIN','mpg'],['PTS','pts'],['REB','reb'],['AST','ast'],['TS%','ts'],['USG%','usg'],['PIE','pie'],['NetRtg','netRtg']]
        .map(([lab,k])=>`<tr><td class="left">${lab}</td><td>${fmt(get(p,k),colDef(k).type)}</td><td>${fmt(get(c,k),colDef(k).type)}</td></tr>`).join('')}</tbody></table>
      <p class="tiny">Each league is graded against its own population, so the two grades are not on a shared scale.</p>
    </div>`:'';
  const customCards=Object.entries(p.custom||{}).map(([k,v])=>`<div class="detail-card"><div class="k">${esc(colDef('custom.'+k).label)}</div><div class="v">${fmt(v,colDef('custom.'+k).type)}</div></div>`).join('');
  const groups={};
  for(const [k,v] of Object.entries(p.stats||{})){
    const m=k.match(/^(off|oadv|omisc|oscore|ousage|odef|obio|bref|hustle|trk|split)_/);
    const g=m?SRC_LABEL[m[1]]:'Other';
    (groups[g]=groups[g]||[]).push([k,v]);
  }
  const raw=Object.entries(groups).map(([g,items])=>
    `<h4>${esc(g)} <span class="tiny">${items.length} fields</span></h4><div class="raw-grid">${
      items.sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`<div class="raw-row"><span>${esc(humanize(k).replace(/^[^·]+· /,''))}</span><b>${fmt(v,'')}</b></div>`).join('')
    }</div>`).join('');
  const split=finite(p.showcaseGP)&&p.showcaseGP>0
    ? `<p class="tiny">Season line combines ${p.regularGP} Regular Season and ${p.showcaseGP} Showcase Cup games.</p>` : '';
  $('playerDialogBody').innerHTML=`<div class="player-hero"><div><div class="eyebrow">${esc(p.leagueLabel)} · RANK #${p.rank} of ${DATA.counts[p.league]}</div>
      <h2>${esc(p.name)}</h2>
      <p>${esc(p.team)} · ${esc(p.position||'—')} · ${p.age??'—'} yrs · ${esc(p.height||'—')} · ${p.weight?p.weight+' lb':'—'} · ${esc(p.country||'—')}</p>
      <p class="tiny">${p.gp} games · ${num(p.mpg)} mpg · ${p.college?esc(p.college)+' · ':''}${p.draftYear&&p.draftYear!=='Undrafted'?`drafted ${esc(p.draftYear)} rd ${esc(p.draftRound)} pick ${esc(p.draftNumber)}`:'undrafted'}</p>${split}</div></div>
    <div class="player-grid">
      <div class="detail-card"><div class="k">Performance grade</div><div class="v grade ${gradeClass(p.grade)}">${p.grade.toFixed(4)}</div></div>
      <div class="detail-card"><div class="k">PTS / REB / AST</div><div class="v">${line(p)}</div></div>
      <div class="detail-card"><div class="k">TS% / USG%</div><div class="v">${pct(p.ts)} / ${pctPoints(p.usg)}</div></div>
      <div class="detail-card"><div class="k">PIE / NetRtg</div><div class="v">${pct(p.pie)} / ${signed(p.netRtg)}</div></div>
      <div class="detail-card"><div class="k">Sample confidence</div><div class="v">${num(p.sampleConfidence,1)}</div></div>
      ${customCards}
    </div>${crossover}
    <h3>All retained source fields</h3>${raw}`;
  $('playerDialog').showModal();
}

function openCompare(){
  const ps=[...compared].map(id=>currentPlayers().find(p=>p.playerId===id)).filter(Boolean);
  const rows=['rank','grade','gp','mpg','pts','reb','ast','stl','blk','tov','ts','efg','usg','astPct','rebPct',
    'offRtg','defRtg','netRtg','pie','per','ws48','bpm','vorp',...CUSTOM_KEYS];
  $('compareDialogBody').innerHTML=`<h2>Player comparison</h2><div class="table-wrap"><table class="compare-table"><thead><tr><th class="left">Metric</th>${ps.map(p=>`<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>${
    rows.filter(k=>ps.some(p=>finite(get(p,k)))).map(k=>`<tr><td class="left">${esc(colDef(k).label)}</td>${ps.map(p=>`<td>${fmt(get(p,k),colDef(k).type)}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div>`;
  $('compareDialog').showModal();
}

function openMetricDefinitions(){
  const defs=DATA.metricDefinitions||{};
  const gm=DATA.gradeModel||{};
  const shr=gm.shrinkage||{};
  $('metricDialogBody').innerHTML=`<div class="eyebrow">METHODS</div><h2>Grade and custom metric definitions</h2>
    <p>${esc(DATA.sourceNote||'')}</p>
    <p><strong>Season definition.</strong> ${esc(DATA.seasonType||'')}</p>
    <p>The grade is calculated independently inside each league. A player who appeared in both receives two separate records and two separate grades, each built only from what he did in that league.</p>
    <p><strong>Component weights.</strong> ${Object.entries(gm.componentWeights||{}).map(([k,v])=>`${esc(k)} ${(v*100).toFixed(0)}%`).join(' · ')}</p>
    <p><strong>Shrinkage constant K.</strong> NBA ${esc(String(shr.NBA?.K??'—'))} minutes · G League ${esc(String(shr.GLEAGUE?.K??'—'))} minutes. ${esc(shr.rationale||'')}</p>
    <div class="metric-list">${Object.entries(defs).map(([k,v])=>`<div class="metric-definition"><strong>${esc(BASE_COLS['custom.'+k]?.label||colDef(k).label)}</strong><span>${esc(v)}</span></div>`).join('')}</div>`;
  $('metricDialog').showModal();
}

function percentileMap(players,key){
  const vals=players.map(p=>({p,v:get(p,key)})).filter(x=>finite(x.v)).map(x=>({...x,v:Number(x.v)})).sort((a,b)=>a.v-b.v);
  const m=new Map(); if(!vals.length)return m;
  vals.forEach((x,i)=>m.set(x.p.playerId,vals.length===1?50:100*i/(vals.length-1))); return m;
}
function applyLab(){
  labConfig=[1,2,3,4].map(i=>({key:$(`labMetric${i}`).value,w:Number($(`labWeight${i}`).value)||0})).filter(x=>x.key&&x.w!==0);
  const players=currentPlayers();
  if(!labConfig.length){players.forEach(p=>delete p.labScore);render();return}
  const maps=Object.fromEntries(labConfig.map(x=>[x.key,percentileMap(players,x.key)]));
  const denom=labConfig.reduce((a,x)=>a+Math.abs(x.w),0)||1;
  for(const p of players)p.labScore=labConfig.reduce((a,x)=>a+(maps[x.key].get(p.playerId)??50)*x.w,0)/denom;
  sortKey='labScore';sortDir=-1;render();
}

function exportNote(msg){
  const b=$('exportBtn'), original=b.dataset.label||(b.dataset.label=b.textContent);
  b.textContent=msg; setTimeout(()=>{b.textContent=original},3200);
}

async function exportCsv(){
  const cols=visibleColumns().filter(k=>k!=='select'),list=filteredPlayers();
  const q=v=>`"${String(v??'').replaceAll('"','""')}"`;
  const lines=[cols.map(k=>q(colDef(k).label)).join(',')];
  for(const p of list)lines.push(cols.map(k=>q(get(p,k))).join(','));
  const csv=lines.join('\n');
  const base=`${league.toLowerCase()}_2025-26_rankings`;

  // Published-artifact path: the frame cannot download on its own, so hand the file
  // to the host and let the viewer confirm it.
  const downloads=await capability('downloads');
  if(downloads){
    // .csv sits in the host's extended extension set and may not be enabled; .txt always is.
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

  // Local path: an ordinary browser download.
  const blob=new Blob([csv],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`${base}.csv`;a.click();URL.revokeObjectURL(url);
}

/** Resolve a host runtime capability, or null when this view cannot run it. */
async function capability(name){
  try{ return window.claude?.use ? await window.claude.use(name) : null; }
  catch{ return null; }
}

function reset(){
  ['searchInput','teamFilter','positionFilter','countryFilter'].forEach(id=>$(id).value='');
  ['minGp','minMpg','minMin','minGrade'].forEach(id=>$(id).value=0);
  $('bothOnly').checked=false;$('confidenceOnly').checked=false;rules=[];render();
}

function fillMetricSelects(){
  const keys=metricRegistryKeys();
  const options=keys.map(k=>`<option value="${esc(k)}">${esc(colDef(k).label)}</option>`).join('');
  const old=[1,2,3,4].map(i=>$(`labMetric${i}`)?.value||'');
  [1,2,3,4].forEach(i=>{$(`labMetric${i}`).innerHTML=`<option value="">— metric ${i} —</option>${options}`});
  const dflt=['pts','custom.twoWayIndex','custom.efficiencyOverExpected',''];
  [1,2,3,4].forEach(i=>{$(`labMetric${i}`).value=keys.includes(old[i-1])?old[i-1]:(keys.includes(dflt[i-1])?dflt[i-1]:'')});
  $('ruleMetric').innerHTML=options;
}

function switchLeague(b){
  league=b.dataset.league;
  document.querySelectorAll('.league-tab').forEach(x=>x.classList.toggle('active',x===b));
  compared.clear();rules=[];labConfig=[];sortKey='grade';sortDir=-1;
  currentPlayers().forEach(p=>delete p.labScore);
  populateSelectors();fillMetricSelects();renderSummary();render();
}

function bind(){
  document.querySelectorAll('.league-tab').forEach(b=>b.onclick=()=>switchLeague(b));
  ['searchInput','teamFilter','positionFilter','countryFilter','minGp','minMpg','minMin','minGrade','bothOnly','confidenceOnly','viewPreset','rowLimit']
    .forEach(id=>$(id).addEventListener(id==='searchInput'?'input':'change',render));
  $('resetBtn').onclick=reset;$('exportBtn').onclick=exportCsv;$('aboutBtn').onclick=openMetricDefinitions;$('applyLab').onclick=applyLab;
  $('compareBtn').onclick=openCompare;$('clearCompareBtn').onclick=()=>{compared.clear();render()};
  $('addRuleBtn').onclick=()=>$('ruleDialog').showModal();
  $('saveRuleBtn').onclick=()=>{rules.push({key:$('ruleMetric').value,op:$('ruleOp').value,value:Number($('ruleValue').value)});$('ruleDialog').close();render();};
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
}

async function init(){
  try{
    const r=await fetch('./public/data.json',{cache:'no-store'}); if(!r.ok)throw new Error(`data.json returned ${r.status}`); DATA=await r.json();
    $('nbaCount').textContent=DATA.counts.NBA.toLocaleString();$('gCount').textContent=DATA.counts.GLEAGUE.toLocaleString();
    $('sourceLine').textContent=`${DATA.primarySource} · ${DATA.counts.NBA+DATA.counts.GLEAGUE} players · generated ${new Date(DATA.generatedAt).toLocaleString()}`;
    populateSelectors();fillMetricSelects();renderSummary();bind();render();
    // In a published view the frame cannot download on its own. If the host will not
    // mediate a save either, drop the affordance rather than leave a dead button.
    if(window.claude && !(await capability('downloads'))) $('exportBtn').hidden=true;
  }catch(e){
    $('sourceLine').textContent='The data build has not completed yet.';
    $('tableBody').innerHTML=`<tr><td class="error">${esc(e.message)}. Run <code>npm run build</code> to generate public/data.json.</td></tr>`;
  }
}
init();
