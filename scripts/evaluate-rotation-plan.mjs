// Chronological workload check of the position allocator alone. Team membership
// is reconstructed from appearances known at the cutoff; no future minutes
// influence inputs. Historical Out reports and archived listed positions are
// unavailable, so this does not test injury-aware decisions or gains in wins.
import fs from 'node:fs';
import {prepare} from './lib/projection.mjs';
import {allocateRotation} from './lib/rotation-allocation.mjs';
const root=new URL('../',import.meta.url);
const D=prepare(JSON.parse(fs.readFileSync(new URL('scripts/data/projection/inputs.json',root))));
const seasons=['2023-24','2024-25'];const results=[];
for(const season of seasons){
  const rows=JSON.parse(fs.readFileSync(new URL(`scripts/data/history/${season}/gamelog.json`,root)));
  const teams=[...new Set(rows.map(r=>r.team))].sort();
  for(const team of teams){
    const own=rows.filter(r=>r.team===team).sort((a,b)=>a.gameDate.localeCompare(b.gameDate)||a.gameId.localeCompare(b.gameId)||a.playerId-b.playerId);
    const games=[...new Set(own.map(r=>r.gameId))];
    if(games.length<50)throw new Error('Incomplete historical team games');
    const first=new Set(games.slice(0,20));const cutoff=own.filter(r=>first.has(r.gameId)).at(-1).gameDate;
    const latestTeam=new Map();for(const r of rows.filter(r=>r.gameDate<=cutoff).sort((a,b)=>a.gameDate.localeCompare(b.gameDate)||a.gameId.localeCompare(b.gameId)))latestTeam.set(r.playerId,r.team);
    const players=[...new Set(own.filter(r=>first.has(r.gameId)&&latestTeam.get(r.playerId)===team).map(r=>r.playerId))].sort((a,b)=>a-b);
    const sample=players.map(id=>({id,position:D.bio.get(id)?.position,target:own.filter(r=>r.playerId===id&&first.has(r.gameId)).reduce((s,r)=>s+r.min,0)/20}));
    const plan=allocateRotation(sample);
    const future=new Set(games.slice(20,50));
    const scored=sample.map(p=>{const actual=own.filter(r=>r.playerId===p.id&&future.has(r.gameId)).reduce((s,r)=>s+r.min,0)/30;const predicted=plan.players.find(r=>r.id===String(p.id)).minutes;return {id:p.id,baseline:p.target,planned:predicted,actual};});
    const mae=key=>scored.reduce((s,r)=>s+Math.abs(r[key]-r.actual),0)/scored.length;
    results.push({season,team,cutoff,observedTeamGames:20,heldoutTeamGames:30,players:scored.length,status:plan.status,unfilledByPosition:plan.unfilledByPosition,baselineMae:mae('baseline'),plannedMae:mae('planned'),unmodeledFutureMinutes:own.filter(r=>future.has(r.gameId)&&!players.includes(r.playerId)).reduce((s,r)=>s+r.min,0)/30});
  }
}
const rounded=JSON.parse(JSON.stringify({version:1,protocol:'At each team’s 20th completed game, use observed per-team-game minutes as targets; allocate listed-position minutes, then score effective MPG over the next 30 team games. No outcome selects the step, bounds or objective.',boundary:'Workload allocator only. Listed positions come from the preserved player index, not an archived cutoff index. Appearance-derived membership omits signed nonappearers; future entrants remain an explicit unmodeled-minute total. Historical medical reports and TULIP value signals are not evaluated. This does not establish win-maximizing recommendations.',results},(k,v)=>typeof v==='number'?Math.round(v*1000)/1000:v));
fs.writeFileSync(new URL('docs/ROTATION_PLAN_EVALUATION.json',root),JSON.stringify(rounded,null,2)+'\n');
console.log(JSON.stringify({teams:results.length,feasible:results.filter(r=>r.status==='feasible').length,baselineMae:results.reduce((s,r)=>s+r.baselineMae,0)/results.length,plannedMae:results.reduce((s,r)=>s+r.plannedMae,0)/results.length}));
