import {test,expect} from '@playwright/test';
const url=process.env.SEASON_DASHBOARD_URL||new URL('../public/standalone.html',import.meta.url).href;
test('current scores explain missing values and expose daily refresh and team results',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await expect(page.locator('.season-refresh')).toContainText('7:17 AM and 10:17 AM');
 await expect(page.locator('.season-refresh a')).toHaveAttribute('href',/daily-season-refresh/);
 await page.selectOption('#seasonLimit','1000');
 const stats=await page.evaluate(()=>({columns:Object.fromEntries([...document.querySelectorAll('.season-table > table > thead [data-season-sort]')].map((b,i)=>[b.dataset.seasonSort,i])),players:DATA.leagues.NBA.filter(p=>p.currentRoster||p.seasonActual?.gp>0).map(p=>({id:p.playerId,gp:p.seasonActual?.gp||0,grade:p.currentGrades?.['Regular Season']?.grade,tulip:!p.tulipRotation?.abstain?p.tulipRotation?.tulip:null})),rows:[...document.querySelectorAll('.season-table > table > tbody > tr')].map(r=>({id:r.querySelector('[data-season-player]')?.dataset.seasonPlayer,cells:[...r.cells].map(c=>c.textContent)}))}));
 expect(stats.rows.length).toBe(stats.players.length);const byId=new Map(stats.players.map(p=>[String(p.id),p]));
 for(const r of stats.rows){const p=byId.get(r.id),grade=r.cells[stats.columns.grade],tulip=r.cells[stats.columns.tulip];if(p.gp>0)expect(grade).toBe((Math.floor(p.grade*10000)/10000).toFixed(4));else expect(grade).toBe('No games');if(p.tulip==null)expect(tulip).toMatch(/Out|No games|No feasible plan|No roster|Insufficient data/);else expect(Number(tulip)).toBe(p.tulip);}
 await expect(page.locator('#seasonTeams')).not.toHaveAttribute('open','');await page.locator('#seasonTeams summary').click();await expect(page.locator('#seasonTeams tbody tr')).toHaveCount(30);
 await page.evaluate(()=>{for(const c of Object.values(DATA.currentGradeMeta.cohorts))c.asOf='2020-01-01T00:00:00Z';window.__wsRefresh();});await expect(page.locator('.season-stale')).toContainText('Update overdue');expect(errors).toEqual([]);
});
