// Independent reference audit: read the committed source tables, not the builder's helpers.
// Fail on any displayed period/stat or narrative evidence that cannot be reproduced from them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { aggregateProfile, stableReferenceProfiles } from '../scripts/lib/comparison-profiles.mjs';

const read = path => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const data = read('../public/data.json');
const inputs = read('../scripts/data/projection/inputs.json');
const combine = read('../scripts/data/combine_anthro.json');
const valid = x => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
const n = x => valid(x) ? Number(x) : null;
const decode = t => (t?.rows || []).map(r => Object.fromEntries(t.headers.map((h, i) => [h, r[i]])));
const inches = h => {
  if (valid(h)) return Number(h);
  const m = String(h || '').match(/^(\d+)[-'’]\s*(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 12 + Number(m[2]) : null;
};
const total = (rows, key) => rows.reduce((s, r) => s + Number(r[key]), 0);
const mean = (rows, value) => {
  const known = rows.filter(r => valid(value(r)));
  return known.length ? known.reduce((s, r) => s + value(r) * r.MIN, 0) / total(known, 'MIN') : null;
};
const close = (actual, expected, label, digits = null) => {
  if (expected == null) assert.equal(actual, null, `${label}: missing must remain null`);
  else assert.ok(valid(actual) && Math.abs(actual - expected) <= (digits == null ? 1e-9 : 0.5 * 10 ** -digits + 1e-9), `${label}: ${actual} != ${expected}`);
};

// Independent bio resolution from the published source tables. Missing measurements stay missing.
const bio = new Map();
for (const x of decode(inputs.playerIndex)) bio.set(String(x.PERSON_ID), { name:[x.PLAYER_FIRST_NAME,x.PLAYER_LAST_NAME].filter(Boolean).join(' '), height:inches(x.HEIGHT), weight:n(x.WEIGHT) });
for (const x of decode(inputs.rosters2627)) if (!bio.has(String(x.PERSON_ID))) bio.set(String(x.PERSON_ID), { name:[x.PLAYER_FIRST_NAME,x.PLAYER_LAST_NAME].filter(Boolean).join(' '), height:inches(x.HEIGHT), weight:n(x.WEIGHT) });
for (const league of ['NBA','GLEAGUE']) for (const p of data.leagues[league]) {
  const id = String(p.nbaPersonId ?? p.playerId), b = bio.get(id) || {};
  bio.set(id, { name:b.name || p.name, height:b.height ?? n(p.heightInches) ?? inches(p.height), weight:b.weight ?? n(p.weight) });
}
const measurements = new Map(combine.rows.map(x => [String(x.playerId ?? x.PLAYER_ID), {
  wingspan:n(x.wingspanInches ?? x.WINGSPAN), standingReach:n(x.standingReachInches ?? x.STANDING_REACH),
  height:n(x.heightNoShoesInches ?? x.HEIGHT_WO_SHOES), weight:n(x.weight ?? x.WEIGHT),
}]));

const per36 = {pts36:'PTS',fga36:'FGA',threeA36:'FG3A',fta36:'FTA',reb36:'REB',ast36:'AST',stl36:'STL',blk36:'BLK',tov36:'TOV',pf36:'PF',plusMinus36:'PLUS_MINUS',oreb36:'OREB',dreb36:'DREB'};
const advanced = {usg:'USG_PCT',astPct:'AST_PCT',astRatio:'AST_RATIO',orebPct:'OREB_PCT',drebPct:'DREB_PCT',rebPct:'REB_PCT',offRtg:'OFF_RATING',defRtg:'DEF_RATING',netRtg:'NET_RATING',tmTovPct:'TM_TOV_PCT',pie:'PIE'};
const ratios = {fgPct:['FGM','FGA',1],fg3Pct:['FG3M','FG3A',50],ftPct:['FTM','FTA',30],threeRate:['FG3A','FGA',1],ftRate:['FTA','FGA',1],astTo:['AST','TOV',1]};
const counts = {};

for (const league of ['NBA','GLEAGUE']) {
  const rowsByPlayer = new Map();
  for (const [season, tables] of Object.entries(inputs[league === 'NBA' ? 'nba' : 'gleague'])) {
    const advancedRows = new Map(decode(tables.adv).map(r => [String(r.PLAYER_ID), r]));
    const ids = new Set();
    for (const row of decode(tables.base)) {
      const id = String(row.PLAYER_ID);
      assert.ok(!ids.has(id), `${league} ${season}: duplicate source player ${id}`);
      ids.add(id);
      if (!(row.MIN >= (league === 'NBA' ? 300 : 200)) || !(row.GP > 0) || !/[A-Za-z]/.test(row.PLAYER_NAME || bio.get(id)?.name || '')) continue;
      if (!rowsByPlayer.has(id)) rowsByPlayer.set(id, []);
      rowsByPlayer.get(id).push({...row, season, year:Number(season.slice(0,4)), advanced:advancedRows.get(id) || {}});
    }
  }
  const expected = new Map();
  for (const [id, history] of rowsByPlayer) {
    // Exhaust all calendar starts, rather than calling stableReferenceProfiles or reusing a
    // chosen period from the artifact. Two meaningful seasons outrank a lone high-minute year.
    let best = null, bestScore = null;
    for (let start = Math.min(...history.map(r=>r.year)); start <= Math.max(...history.map(r=>r.year)); start++) {
      const rows = history.filter(r => r.year >= start && r.year <= start + 2).sort((a,b)=>a.year-b.year);
      if (!rows.length) continue;
      const score = [Math.min(rows.length,2), total(rows,'MIN'), rows.at(-1).year];
      const better = !bestScore || score.some((v,i)=>v>bestScore[i] && score.slice(0,i).every((x,j)=>x===bestScore[j]));
      if (better) { best=rows; bestScore=score; }
    }
    const anchor=best.slice().sort((a,b)=>b.MIN-a.MIN || b.year-a.year)[0];
    const stats={mpg:total(best,'MIN')/total(best,'GP'),age:mean(best,r=>n(r.AGE))};
    for (const [key,field] of Object.entries(per36)) {
      const known=best.filter(r=>valid(r[field]));
      stats[key]=known.length ? 36*total(known,field)/total(known,'MIN') : null;
    }
    for (const [key,field] of Object.entries(advanced)) stats[key]=mean(best,r=>n(r.advanced[field]));
    for (const [key,[num,den,min]] of Object.entries(ratios)) stats[key]=best.every(r=>valid(r[num])&&valid(r[den])) && total(best,den)>=min ? total(best,num)/total(best,den) : null;
    stats.efgPct=best.every(r=>['FGM','FGA','FG3M'].every(k=>valid(r[k]))) && total(best,'FGA')>0 ? (total(best,'FGM')+0.5*total(best,'FG3M'))/total(best,'FGA') : null;
    stats.ts=mean(best,r=>valid(r.advanced.TS_PCT) ? Number(r.advanced.TS_PCT) : ['PTS','FGA','FTA'].every(k=>valid(r[k])) && r.FGA+0.44*r.FTA>0 ? r.PTS/(2*(r.FGA+0.44*r.FTA)) : null);
    const b=bio.get(id)||{},c=measurements.get(id)||{};
    expected.set(id,{anchor,rows:best,stats,physical:{height:b.height??c.height??null,weight:b.weight??c.weight??null,wingspan:c.wingspan??null,standingReach:c.standingReach??null}});
  }
  let checked=0,style=0,limited=0;
  const used=new Set();
  function period(id, p, label) {
    const e=expected.get(String(id));
    assert.ok(e, `${label}: no eligible source reference ${id}`);
    const seasons=e.rows.map(r=>r.season);
    assert.deepEqual(p?.seasons,seasons,`${label}: cherry-picked/wrong window`);
    assert.equal(p.seasonCount,seasons.length,`${label}: season count`);
    assert.equal(p.period,seasons.length===1?seasons[0]:`${seasons[0]}–${seasons.at(-1)}`,`${label}: period label`);
    assert.equal(p.limited,seasons.length===1,`${label}: single-season limit`);
    assert.equal(p.games,total(e.rows,'GP'),`${label}: games`);
    close(p.minutes,total(e.rows,'MIN'),`${label}: minutes`,1);
    used.add(String(id));
    return e;
  }
  for (const [target, set] of Object.entries(data.analysis.playerComps[league])) {
    for (const ref of [...set.top3,...set.nearestOverall]) {
      const label=`${league} target ${target} reference ${ref.playerId}`;
      const e=period(ref.playerId,ref.referenceProfile,label);
      assert.equal(ref.season,ref.referenceProfile.period,`${label}: serialized season`);
      assert.equal(ref.team,e.anchor.TEAM_ABBREVIATION,`${label}: anchor team`);
      assert.equal(ref.name,e.anchor.PLAYER_NAME || bio.get(String(ref.playerId))?.name,`${label}: identity`);
      for (const [key,value] of Object.entries(e.stats)) close(ref[key],value,`${label}: ${key}`,key==='astTo'?2:key==='age'||key==='mpg'||key.endsWith('36')||['offRtg','defRtg','netRtg'].includes(key)?1:3);
      for(const [key,value] of [['heightInches',e.physical.height],['weight',e.physical.weight],['wingspanInches',e.physical.wingspan]]) close(ref[key],value,`${label}: ${key}`,1);
      for(const [key,value] of [['height',e.physical.height],['wingspan',e.physical.wingspan],['standingReach',e.physical.standingReach]]) close(inches(ref[key]),value,`${label}: formatted ${key}`,1);
      if(ref.referenceProfile.limited) limited++;
      checked++;
    }
    for(const [block,ref] of Object.entries(set.profileRead.references)) {
      const label=`${league} target ${target} ${block} reference ${ref.playerId}`;
      const e=period(ref.playerId,ref.referencePeriod,label);
      assert.ok(e.rows.length>=2,`${label}: single-season style analogy`);
      assert.equal(ref.season,ref.referencePeriod.period,`${label}: style period label`);
      assert.equal(ref.name,e.anchor.PLAYER_NAME || bio.get(String(ref.playerId))?.name,`${label}: identity`);
      assert.deepEqual(ref.axes,ref.evidence.map(x=>x.key),`${label}: axes/evidence`);
      for(const axis of ref.evidence) close(axis.reference,(block==='physical'?e.physical:e.stats)[axis.key],`${label}: ${axis.key}`);
      style++;
    }
    for(const component of set.profileRead.components) {
      period(component.playerId,component.referencePeriod,`${league} target ${target} component`);
      assert.equal(component.season,component.referencePeriod.period);
      assert.ok(component.evidence.length>0);
      for(const block of component.evidence) {
        const ref=set.profileRead.references[block];
        assert.equal(ref.playerId,component.playerId);
        assert.ok(component.phrase.includes(ref.phrase));
        assert.deepEqual(component.referencePeriod,ref.referencePeriod);
      }
    }
    for(const ref of set.blend) {
      const card=set.top3.find(r=>r.playerId===ref.playerId);
      assert.ok(card,'blend must point to a verified reference card');
      assert.equal(ref.season,card.referenceProfile.period);
      assert.equal(ref.name,card.name);
    }
  }
  counts[league]={overallAndBlendReferences:checked,styleReferences:style,limitedReferences:limited,uniqueIdentities:used.size};
}

// Synthetic adversarial inputs test the actual aggregation/selection functions, not the audit.
const row=(season,minutes,extra={})=>({league:'NBA',playerId:'p',name:'Example',season,minutes,gp:20,age:25,physical:{},features:{fg3Pct:0.9},totals:{FG3M:10,FG3A:50,FGA:100,FGM:40,FTM:20,FTA:40,AST:50,TOV:20},...extra});
const seasons=[row('2010-11',1000),row('2011-12',1000),row('2015-16',2000),row('2016-17',2000),row('2020-21',9000)];
assert.deepEqual(stableReferenceProfiles(seasons)[0].referenceProfile.seasons,['2015-16','2016-17']);
assert.deepEqual(stableReferenceProfiles(seasons.toReversed()),stableReferenceProfiles(seasons),'input order cannot select a different identity');
const tie=[row('2010-11',500),row('2011-12',500),row('2014-15',500),row('2015-16',500)];
assert.deepEqual(stableReferenceProfiles(tie)[0].referenceProfile.seasons,['2014-15','2015-16']);
assert.throws(()=>stableReferenceProfiles([seasons[0],seasons[0]]),/Duplicate/);
assert.throws(()=>aggregateProfile([seasons[0],{...seasons[1],playerId:'other'}]),/same player/);
assert.equal(stableReferenceProfiles([seasons[0],{...seasons[0],league:'GLEAGUE'}]).length,2);
assert.equal(stableReferenceProfiles([row('2010-11',null)]).length,0);
const pooled=aggregateProfile([row('2010-11',500,{age:null}),row('2011-12',1000)]);
assert.equal(pooled.age,25,'unknown age must not depress the pooled age');
assert.equal(pooled.features.fg3Pct,0.2,'pool attempts; do not average the 90% source feature');
assert.equal(aggregateProfile([row('2010-11',500,{age:null})]).age,null);
assert.equal(aggregateProfile([row('2010-11',500,{totals:{FG3A:null,FG3M:10}})]).features.fg3Pct,null);
assert.equal(aggregateProfile([row('2010-11',500,{features:{efgPct:0.8},totals:{FGM:40,FGA:null,FG3M:10}})]).features.efgPct,null);
console.log('Independent comparison-reference audit passed:',JSON.stringify(counts));
console.log('Source SHA256:',crypto.createHash('sha256').update(fs.readFileSync(new URL('../scripts/data/projection/inputs.json',import.meta.url))).digest('hex'));
