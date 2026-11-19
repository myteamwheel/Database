// Reproduce the frozen model used for 2026–27 from the official prior season.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {ridge} from './lib/projection.mjs';
import {teamGames, rotationFeatures, planRoster, distributeMinutes} from './lib/gleague-rotation.mjs';

const dir = new URL('./data/gleague-rotation/', import.meta.url);
const sources = [];
const games = ['Showcase','Regular Season'].flatMap(phase => {
  const bytes = zlib.gunzipSync(fs.readFileSync(new URL(phase.replace(' ','')+'-2025-26.json.gz',dir)));
  const payload = JSON.parse(bytes);
  if (payload.parameters.Season !== '2025-26' || payload.parameters.SeasonType !== phase || payload.parameters.LeagueID !== '20') throw Error('Wrong prior season');
  const url = new URL('https://stats.gleague.nba.com/stats/leaguegamelog');
  url.search = new URLSearchParams(payload.parameters);
  sources.push({phase,url:url.href,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  return teamGames(payload,'2026-03-28');
});
const trainThrough = '2026-02-28';
const X = [], y = [], heldOut = [];
let teamGamesTrained = 0, newcomerMinutes = 0;
for (const season of Map.groupBy(games,g => g.team).values()) {
  const history = [];
  for (const game of season.sort((a,b) => a.day.localeCompare(b.day))) {
    if (history.length) {
      const known = [...new Set(history.slice(-5).flatMap(g => [...g.lines.keys()]))].sort();
      if (game.day <= trainThrough) {
        for (const id of known) { X.push(rotationFeatures(history,id)); y.push(game.lines.get(id)?.minutes ?? 0); }
        newcomerMinutes += [...game.lines].filter(([id]) => !known.includes(id)).reduce((s,[,r]) => s+r.minutes,0);
        teamGamesTrained++;
      } else heldOut.push({history:history.slice(),game,known});
    }
    history.push(game);
  }
}
const coefficients = ridge(X,y,null,1);
const model = {version:'gleague-rotation-v1',trainThrough,coefficients,newcomerPool:newcomerMinutes/teamGamesTrained,sources};
let error=0, repeatError=0, n=0, teamGamesTested=0;
// Old roster snapshots are unavailable. Reserve a pool for previously unseen
// players. Evaluate only individually identifiable recent players, including DNPs.
for (const {history,game,known} of heldOut) {
  const ids = [...known,'reserve'];
  const planned = planRoster(history,ids,model);
  if (!planned) continue;
  const repeat = distributeMinutes(ids.map(id => ({id,target:id==='reserve'?model.newcomerPool:rotationFeatures(history,id)[3]})));
  for (const id of known) {
    const actual = game.lines.get(id)?.minutes ?? 0;
    error += Math.abs(planned.get(id)-actual); repeatError += Math.abs(repeat.get(id)-actual); n++;
  }
  teamGamesTested++;
}
model.validation = {start:'2026-03-01',end:'2026-03-28',teamGames:teamGamesTested,playerGames:n,
  mae:+(error/n).toFixed(2),repeatMpgMae:+(repeatError/n).toFixed(2),trainingPlayerGames:y.length};
fs.writeFileSync(new URL('model.json',dir),JSON.stringify(model,null,2)+'\n');
console.log(model.validation);
