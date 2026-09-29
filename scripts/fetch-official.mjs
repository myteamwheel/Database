// node scripts/fetch-official.mjs <00|20> <destination> [Regular Season|Showcase] [2025-26]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { refreshSources } from './lib/refresh.mjs';

export function officialJobs(leagueId, season = '2025-26', seasonType = 'Regular Season') {
  if (!['00', '20'].includes(leagueId) || !/^\d{4}-\d{2}$/.test(season) || !['Regular Season', 'Showcase'].includes(seasonType)) throw new Error('Invalid league, season or season type');
  const base = { College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '', DraftPick: '', DraftYear: '',
    GameScope: '', GameSegment: '', Height: '', LastNGames: '0', LeagueID: leagueId, Location: '', Month: '0', OpponentTeamID: '0',
    Outcome: '', PORound: '0', PaceAdjust: 'N', Period: '0', PlayerExperience: '', PlayerPosition: '', PlusMinus: 'N', Rank: 'N',
    Season: season, SeasonSegment: '', SeasonType: seasonType, ShotClockRange: '', StarterBench: '', TeamID: '0', TwoWay: '0',
    VsConference: '', VsDivision: '', Weight: '' };
  const url = (endpoint, extra) => `https://stats.nba.com/stats/${endpoint}?${new URLSearchParams({ ...base, ...extra })}`;
  const dash = (measure, mode) => url('leaguedashplayerstats', { MeasureType: measure, PerMode: mode });
  const jobs = [['base_pergame', 'Base', 'PerGame'], ['base_totals', 'Base', 'Totals'], ['base_per36', 'Base', 'Per36'],
    ['base_per100', 'Base', 'Per100Possessions'], ['advanced', 'Advanced', 'PerGame'], ['misc', 'Misc', 'PerGame'],
    ['scoring', 'Scoring', 'PerGame'], ['usage', 'Usage', 'PerGame'], ['defense', 'Defense', 'PerGame'], ['fourfactors', 'Four Factors', 'PerGame']]
    .map(([name, measure, mode]) => ({ name, url: dash(measure, mode), required: ['base_totals', 'base_pergame', 'advanced'].includes(name),
      columns: ['PLAYER_ID', ...(name.startsWith('base_') ? ['GP', 'MIN', 'PTS', 'FGM', 'FGA'] : [])], totals: name === 'base_totals' }));
  jobs.push({ name: 'bios', url: url('leaguedashplayerbiostats', { PerMode: 'PerGame' }), columns: ['PLAYER_ID'] });
  jobs.push({ name: 'playerindex', url: url('playerindex', { Historical: '1', DraftRound: '' }), id: 'PERSON_ID', columns: ['PERSON_ID'] });
  jobs.push({ name: 'hustle', url: url('leaguehustlestatsplayer', { PerMode: 'PerGame' }), columns: ['PLAYER_ID'] });
  for (const [name, type] of [['drives', 'Drives'], ['defense', 'Defense'], ['passing', 'Passing'], ['rebounding', 'Rebounding'],
    ['touches', 'Possessions'], ['catchshoot', 'CatchShoot'], ['pullup', 'PullUpShot'], ['efficiency', 'Efficiency']]) {
    jobs.push({ name: `pt_${name}`, url: url('leaguedashptstats', { PerMode: 'PerGame', PlayerOrTeam: 'Player', PtMeasureType: type }), columns: ['PLAYER_ID'] });
  }
  return jobs;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [leagueId, destination = 'scripts/data/official', seasonType = 'Regular Season', season = '2025-26'] = process.argv.slice(2);
  const result = await refreshSources({ jobs: officialJobs(leagueId, season, seasonType), outDir: path.resolve(root, destination), season, seasonType, leagueId });
  console.log(JSON.stringify({ leagueId, season, seasonType, changed: result.changed, retained: result.retained }));
}
