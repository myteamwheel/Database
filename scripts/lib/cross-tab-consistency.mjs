import { teamFit } from './analysis.mjs';

const normName = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const same = (a,b,tol=1e-9) => Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a-b) <= tol : a === b;

export function auditCrossTabConsistency(data) {
  if (!data?.leagues?.NBA || !data?.leagues?.GLEAGUE) throw new Error('Cross-tab audit requires NBA and G League arrays.');
  const errors = [];
  const warnings = [];
  const nba = data.leagues.NBA;
  const gl = data.leagues.GLEAGUE;
  const teamsByLeague = data.analysis?.teams || {};
  const teamFitTeams = [];
  const currentRosterProjectionTeams = [];

  const checkUnique = (league, rows) => {
    const ids = new Set();
    for (const p of rows) {
      const id = String(p.playerId ?? '');
      if (!id) errors.push(`${league}: player missing playerId (${p.name || 'unknown'})`);
      else if (ids.has(id)) errors.push(`${league}: duplicate playerId ${id}`);
      ids.add(id);
    }
  };
  checkUnique('NBA', nba);
  checkUnique('GLEAGUE', gl);

  const nbaById = new Map(nba.map((p) => [String(p.playerId), p]));
  const glById = new Map(gl.map((p) => [String(p.playerId), p]));

  const historicalSeason = data.season || null;
  const projectionSeason = data.projectionMeta?.season || null;
  const projectionTimeframe = data.projectionMeta?.timeframe || null;
  if (historicalSeason && data.projectionMeta?.basedOn && data.projectionMeta.basedOn !== historicalSeason) {
    errors.push(`projectionMeta.basedOn ${data.projectionMeta.basedOn} does not match historical season ${historicalSeason}`);
  }

  for (const p of nba) {
    if (p.currentRoster && !p.currentTeam) errors.push(`NBA: current-roster player ${p.name} has no currentTeam`);
    if (p.currentRoster && !p.appeared && (p.grade != null || p.rank != null)) {
      errors.push(`NBA: roster-only player ${p.name} has a performance grade/rank`);
    }
    if (p.proj && !p.proj.abstain) {
      if (projectionSeason && p.proj.season !== projectionSeason) errors.push(`NBA: ${p.name} projection season ${p.proj.season} != ${projectionSeason}`);
      if (projectionTimeframe && p.proj.timeframe !== projectionTimeframe) errors.push(`NBA: ${p.name} projection timeframe mismatch`);
      if (p.currentRoster && p.currentTeam) {
        currentRosterProjectionTeams.push({ playerId:p.playerId, name:p.name, currentTeam:p.currentTeam, projectionTeam:p.proj.team ?? null });
        if (p.proj.team !== p.currentTeam) errors.push(`NBA: ${p.name} projection team ${p.proj.team ?? 'null'} != current roster ${p.currentTeam}`);
      }
    }
    if (p.appeared && p.currentTeam && p.skillProfile) {
      const tp = teamsByLeague.NBA?.[p.currentTeam];
      if (!tp) errors.push(`NBA: ${p.name} current team ${p.currentTeam} missing Team Fit profile`);
      else {
        const expected = teamFit(p.skillProfile, tp.needs);
        if (!p.ownTeamFit) errors.push(`NBA: ${p.name} missing ownTeamFit for ${p.currentTeam}`);
        else if (expected && !same(expected.score, p.ownTeamFit.score, 1e-9)) {
          errors.push(`NBA: ${p.name} ownTeamFit ${p.ownTeamFit.score} != recomputed ${expected.score}`);
        }
      }
    }
    if (p.appeared && p.currentTeam && p.team && p.currentTeam !== p.team) {
      const historicalTeams = new Set((p.teams || []).map((x) => x.team).filter(Boolean));
      if (!historicalTeams.has(p.team)) warnings.push(`NBA: ${p.name} historical team ${p.team} is not represented in team history`);
    }
  }

  for (const p of gl) {
    if (p.proj && !p.proj.abstain) {
      if (projectionSeason && p.proj.season !== projectionSeason) errors.push(`GLEAGUE: ${p.name} projection season mismatch`);
      if (projectionTimeframe && p.proj.timeframe !== projectionTimeframe) errors.push(`GLEAGUE: ${p.name} projection timeframe mismatch`);
    }
  }

  const auditTeamFit = (league, rows, byId) => {
    const teamMap = teamsByLeague[league] || {};
    for (const [team, published] of Object.entries(teamMap)) {
      const expectedMembers = rows.filter((p) => {
        if (!p.appeared || !p.skillProfile) return false;
        if (league === 'NBA') return p.currentTeam === team;
        return (p.teams || []).some((x) => x.team === team) || p.team === team;
      });
      const row = {
        league,
        team,
        publishedMeasuredProfiles: Number(published.rosterSize || 0),
        expectedMeasuredProfiles: expectedMembers.length,
      };
      teamFitTeams.push(row);
      if (row.publishedMeasuredProfiles !== row.expectedMeasuredProfiles) {
        errors.push(`${league} ${team}: Team Fit rosterSize ${row.publishedMeasuredProfiles} != measured roster profiles ${row.expectedMeasuredProfiles}`);
      }
      if (published.team !== team) errors.push(`${league} ${team}: embedded Team Fit team key mismatch`);
      for (const fit of published.topFits || []) {
        const p = byId.get(String(fit.playerId));
        if (!p || !p.appeared || !p.skillProfile) {
          errors.push(`${league} ${team}: Team Fit references missing/unmeasured player ${fit.playerId}`);
          continue;
        }
        if (fit.name !== p.name) errors.push(`${league} ${team}: Team Fit name mismatch for ${fit.playerId}`);
        if (!same(fit.grade, p.grade, 1e-9)) errors.push(`${league} ${team}: Team Fit grade mismatch for ${p.name}`);
        const expected = teamFit(p.skillProfile, published.needs);
        if (!expected || !same(fit.score, expected.score, 1e-9)) {
          errors.push(`${league} ${team}: Team Fit score mismatch for ${p.name}`);
        }
      }
    }
  };
  auditTeamFit('NBA', nba, nbaById);
  auditTeamFit('GLEAGUE', gl, glById);

  const nbaPeople = new Map(nba.filter((p) => p.nbaPersonId != null).map((p) => [String(p.nbaPersonId), p]));
  let dualLeaguePeople = 0;
  for (const p of gl) {
    if (p.nbaPersonId == null) continue;
    const q = nbaPeople.get(String(p.nbaPersonId));
    if (!q) continue;
    dualLeaguePeople++;
    if (normName(p.name) !== normName(q.name)) warnings.push(`dual-league name differs for NBA person ${p.nbaPersonId}: ${q.name} / ${p.name}`);
  }

  const summary = {
    historicalSeason,
    projectionSeason,
    projectionTimeframe,
    nbaPlayers: nba.length,
    gleaguePlayers: gl.length,
    nbaTeamFitTeams: Object.keys(teamsByLeague.NBA || {}).length,
    gleagueTeamFitTeams: Object.keys(teamsByLeague.GLEAGUE || {}).length,
    currentRosterMeasuredProfiles: nba.filter((p) => p.appeared && p.skillProfile && p.currentTeam).length,
    rosterOnlyPlayers: nba.filter((p) => p.currentRoster && !p.appeared).length,
    tradedCurrentRosterCases: nba.filter((p) => p.appeared && p.currentTeam && p.team && p.currentTeam !== p.team).length,
    dualLeaguePeople,
  };

  return { errors, warnings, summary, teamFitTeams, currentRosterProjectionTeams };
}
