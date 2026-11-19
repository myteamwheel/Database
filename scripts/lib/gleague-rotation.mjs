// Only completed team games enter the workload history. An absent line means
// zero minutes in that team game, never an inferred injury or assignment.
const cap = 40;
const budget = 240;
const round = value => Math.round(value * 10) / 10;

export function teamGames(payload, cutoff) {
  const table = payload?.resultSets?.[0];
  if (!table) return [];
  const index = Object.fromEntries(table.headers.map((key, i) => [key, i]));
  const fields = ['TEAM_ID','PLAYER_ID','GAME_ID','GAME_DATE','WL','MIN','PTS','AST','REB','STL','BLK','TOV','FGA','FGM'];
  if (fields.some(key => index[key] == null)) throw Error('Incomplete G League rotation log schema');
  const games = new Map();
  for (const row of table.rowSet) {
    const get = key => row[index[key]];
    const day = get('GAME_DATE').slice(0, 10), team = get('TEAM_ID'), id = String(get('PLAYER_ID'));
    if (day > cutoff || !['W','L'].includes(get('WL'))) throw Error('Nonfinal G League rotation input');
    const key = team + ':' + get('GAME_ID');
    if (!games.has(key)) games.set(key, {day,team,gameId:get('GAME_ID'),lines:new Map()});
    const lines = games.get(key).lines;
    if (lines.has(id) || !Number.isFinite(get('MIN')) || get('MIN') < 0) throw Error('Invalid G League rotation minutes or identity');
    const production = get('PTS') + get('REB') + get('AST') + get('STL') + get('BLK') - get('TOV') - (get('FGA') - get('FGM'));
    lines.set(id, {minutes:get('MIN'),production});
  }
  return [...games.values()].sort((a,b) => a.day.localeCompare(b.day) || a.gameId.localeCompare(b.gameId));
}

// The fitted coefficients predict minutes in a team game. Using recent team
// dates captures changes in both the size and the frequency of a player's role.
export function rotationFeatures(history, id) {
  const recent = history.slice(-5).map(g => g.lines.get(id));
  if (!recent.some(Boolean)) return null;
  const played = history.map(g => g.lines.get(id)).filter(Boolean);
  const recentMinutes = recent.reduce((s,r) => s + (r?.minutes ?? 0), 0);
  const recentProduction = recent.reduce((s,r) => s + (r?.production ?? 0), 0);
  const mpg = played.reduce((s,r) => s + r.minutes, 0) / played.length;
  return [1, recent.at(-1)?.minutes ?? 0, recentMinutes / recent.length, mpg,
    recent.filter(Boolean).length / recent.length, recentProduction / recent.length];
}

// Allocate in tenths so the displayed player minutes also add up to 240.
export function distributeMinutes(rows, total = budget) {
  if (!rows.length || rows.length * cap < total) return null;
  const ticks = rows.map(() => 0);
  // Allocate in proportion to the targets, redistributing exactly at the cap.
  // D'Hondt highest averages provides deterministic rounding with a cap.
  for (let i = 0; i < Math.round(total * 10); i++) {
    let best = -1, bestPriority = -1;
    for (let j = 0; j < rows.length; j++) {
      if (ticks[j] >= cap * 10) continue;
      const priority = Math.max(0.001, rows[j].target) / (ticks[j] + 1);
      if (priority > bestPriority) { best = j; bestPriority = priority; }
    }
    ticks[best]++;
  }
  return new Map(rows.map((r,i) => [r.id,ticks[i] / 10]));
}

export function planRoster(history, ids, model) {
  if (!history.length || ids.length * cap < budget) return null;
  const features = ids.map(id => rotationFeatures(history,id));
  const newCount = features.filter(f => !f).length;
  const rows = ids.map((id,i) => ({id,target:features[i]
    ? Math.max(0,features[i].reduce((s,v,j) => s + v * model.coefficients[j],0))
    : model.newcomerPool / newCount}));
  return distributeMinutes(rows);
}

export function attachGLeagueRotation(data, snapshot, model) {
  for (const phase of snapshot.phases) {
    if (data.gLeagueSeasonProgress.phases[phase.apiSeasonType].players && !phase.gameLog?.resultSets?.[0]?.rowSet?.length)
      throw Error('Missing completed G League game logs for ' + phase.apiSeasonType);
  }
  const histories = Map.groupBy(snapshot.phases.flatMap(p => teamGames(p.gameLog, snapshot.completedThrough))
    .sort((a,b) => a.day.localeCompare(b.day) || a.gameId.localeCompare(b.gameId)), g => g.team);
  const phase = data.gLeagueSeasonProgress.phases['Regular Season'].players > 0 ? 'Regular Season' : 'Showcase';
  const players = data.leagues.GLEAGUE;
  const rosters = Map.groupBy(players.filter(p => p.currentGLeagueRosterTeam), p => p.currentGLeagueRosterTeam);
  for (const p of players) p.tulipRotation = {abstain:true,reason:'no_gleague_roster'};
  let teams = 0, scores = 0;
  for (const team of data.gLeagueTracker.teams) {
    const roster = rosters.get(team.team) ?? [];
    if (roster.length !== team.listed) throw Error('G League rotation roster differs from official listing: ' + team.team);
    const teamId = Number(new URL(team.source).searchParams.get('TeamID'));
    const history = histories.get(teamId) ?? [];
    const id = p => String(p.nbaPersonId ?? p.playerId);
    const plan = planRoster(history, roster.map(id).sort(), model);
    if (plan) teams++;
    for (const p of roster) {
      if (!plan) { p.tulipRotation = {abstain:true,reason:history.length?'insufficient_roster_capacity':'no_team_games'}; continue; }
      const a = p.gLeagueSeasonActual?.phases?.[phase], currentMpg = a?.perGame?.mpg ?? null;
      const minutes = plan.get(id(p)), gp = a?.gp ?? 0;
      const appearances = history.slice(-5).filter(g => g.lines.has(id(p))).length;
      const tulip = gp > 0 && Number.isFinite(currentMpg) ? round(minutes - currentMpg) : null;
      if (tulip != null) scores++;
      p.tulipRotation = {version:model.version,phase,abstain:false,observedGames:gp,currentMpg,
        recommendedMpg:minutes,tulip,inputSupport:appearances >= 4 ? 'MEDIUM':'LOW',
        availability:'Assignment unconfirmed',asOf:snapshot.completedThrough};
    }
  }
  data.gLeagueRotationMeta = {version:model.version,phase,completedThrough:snapshot.completedThrough,
    rosterAsOf:data.gLeagueTracker.asOf,teams,scores,validation:model.validation};
}
