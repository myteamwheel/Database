export function forecastReferenceRanges(forecast,card,{cohort='all'}={}){
  if(card?.version!=='full-stack-reference-ranges-v1'||card.nominalCoverage!==0.8||!card.calibration?.season||!card.test?.season||!card.bands)throw new Error('Invalid forecast reference card');
  const through=card.calibration.throughSeason||card.calibration.season;
  if(!/^20\d{2}-\d{2}$/.test(through)||through>=card.test.season)throw new Error('Invalid chronological reference card');
  const ranges={};
  for(const key of ['gp','mpg','pts','reb','ast','ptsTotal','minutesTotal']){
    const bands=card.cohortBands?.[key]?.[cohort]||card.bands[key];
    if(!Array.isArray(bands)||![1,2,4].includes(bands.length)||bands.some(b=>!Number.isFinite(b.p10)||!Number.isFinite(b.p90)||b.p10>b.p90||!Number.isSafeInteger(b.n)||b.n<1))throw new Error('Invalid chronological residual bands');
    const point=key==='gp'?forecast.remainingSeason.gp:key==='ptsTotal'?forecast.remainingSeason.totals.pts:key==='minutesTotal'?forecast.remainingSeason.totals.min:forecast.remainingSeason.perGame?.[key];
    if(!Number.isFinite(point))continue;
    const band=bands.find(b=>b.upTo===null||point<=b.upTo)||bands.at(-1);
    let low=Math.max(0,point+band.p10),high=Math.max(0,point+band.p90);
    if(key==='gp'){low=Math.min(forecast.remainingSeason.teamGamesRemaining,low);high=Math.min(forecast.remainingSeason.teamGamesRemaining,high);}
    if(key==='mpg'){low=Math.min(48,low);high=Math.min(48,high);}
    ranges[key]={low,point,high,testCoverage:card.testCoverage?.[key]?.[cohort]??null};
  }
  return {version:card.version,cohort,calibrationSeason:card.calibration.season,testSeason:card.test.season,evaluationReportSha256:card.evaluationReportSha256,ranges,
    note:'Historical reference bands from a replay of the production forecast and in-season update. Observed test coverage is shown; the nominal target is 80%. These are not calibrated odds for today’s roster or medical circumstances.'};
}
