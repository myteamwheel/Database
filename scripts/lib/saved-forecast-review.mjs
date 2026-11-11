// Frozen preseason values only. Never substitute today's revised projections.
export const REVIEW_SCALES = {pts:10,mpg:10,reb:5,ast:5,stl:1,blk:1,tov:2,fg3m:2,ts:0.1};
const REVIEW_FIELDS=[...Object.keys(REVIEW_SCALES),'oreb','dreb','fgm','fga','fg3a','ftm','fta','fgPct','fg3Pct','ftPct'];
export function savedForecastReview(archive) {
  return {forecastId:archive.forecastId,season:archive.season,publishedAt:archive.publishedAt,sourceCommit:archive.sourceCommit,
    scales:REVIEW_SCALES,leagues:Object.fromEntries(Object.entries(archive.leagues).map(([lg,rows])=>[lg,rows.map(p=>({playerId:String(p.playerId),name:p.name,forecastTeam:p.forecastTeam,projection:p.abstain?null:Object.fromEntries(REVIEW_FIELDS.map(k=>[k,p.projection?.[k]??null]))}))]))};
}
