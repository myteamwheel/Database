// Automated regression gate for the built standalone page.
// Runs headless against public/standalone.html; `npm run verify` fails if anything here fails.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + path.join(ROOT, 'public/standalone.html');

/** Console errors are a failure, not noise. */
async function open(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(PAGE);
  await page.waitForFunction(() => document.querySelector('#tableBody tr td'), null, { timeout: 60000 });
  return errors;
}
const count = (page) => page.$eval('#resultCount', (e) => Number(e.textContent.replace(/,/g, '')));
const setVal = (page, id, v) => page.$eval(id, (e, val) => {
  e.value = val; e.dispatchEvent(new Event(e.tagName === 'INPUT' && e.type === 'search' ? 'input' : 'change'));
}, v);
const setCheck = (page, id, v) => page.$eval(id, (e, val) => {
  e.checked = val; e.dispatchEvent(new Event('change'));
}, v);

test.describe('data + load', () => {
  test('both leagues load with the complete field set', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => ({
      nba: document.getElementById('nbaCount').textContent,
      gl: document.getElementById('gCount').textContent,
      nbaCount: DATA.counts.NBA, glCount: DATA.counts.GLEAGUE,
      nbaFields: new Set(DATA.leagues.NBA.flatMap((p) => Object.keys(p.stats || {}))).size,
      glFields: new Set(DATA.leagues.GLEAGUE.flatMap((p) => Object.keys(p.stats || {}))).size,
      catalog: Object.keys(DATA.fieldCatalog || {}).length,
      provenance: DATA.provenance?.sources?.length || 0,
      brefSnapshot: DATA.provenance?.basketballReferenceSnapshot?.generatedAt || null,
      grades: ['grade', 'rateGrade', 'magnitudeGrade'].every((k) => DATA.leagues.NBA[0][k] !== undefined),
    }));
    expect(d.nba).toBe(String(d.nbaCount));
    expect(d.gl).toBe(String(d.glCount));
    expect(d.nbaFields).toBeGreaterThan(800);
    expect(d.glFields).toBeGreaterThan(500);
    expect(d.catalog).toBeGreaterThan(1000);
    expect(d.provenance).toBeGreaterThan(100);
    expect(d.brefSnapshot).toBeTruthy();
    expect(d.grades).toBe(true);
    expect(errors).toEqual([]);
  });

  test('historical player record is compact, phase-aware, and keeps unknown starters unknown', async ({ page }) => {
    const errors = await open(page);
    const data = await page.evaluate(() => {
      const schema = DATA.analysis.history?.browserSchema || [];
      const ix = Object.fromEntries(schema.map((k, i) => [k, i]));
      const p = DATA.leagues.NBA.find((x) => x.name === 'James Harden' && x.history?.length);
      const rows = (p?.history || []).map((r) => Object.fromEntries(schema.map((k, i) => [k, r[i]])));
      const old = rows.find((r) => r.season === '2015-16' && r.seasonType === 'Regular Season');
      // Playoffs of a corrupted season are NOT reconstructed, so they remain genuinely unknown.
      const oldPO = rows.find((r) => r.season === '2015-16' && r.seasonType === 'Playoffs');
      const acceptedRS = rows.find((r) => r.season === '2023-24' && r.seasonType === 'Regular Season');
      const acceptedPO = rows.find((r) => r.season === '2023-24' && r.seasonType === 'Playoffs');
      const rawLeak = schema.some((k) => ['gameId', 'gameDate', 'minutes', 'firstGameDate', 'lastGameDate'].includes(k));
      return { playerId: p?.playerId, schema, old, oldPO, acceptedRS, acceptedPO, rawLeak };
    });
    expect(data.playerId).toBeTruthy();
    expect(data.schema).toEqual(['season', 'seasonType', 'teams', 'gp', 'mpg', 'pts', 'reb', 'ast', 'ts', 'starts', 'startShareOfAppearances', 'starterKnownAppearances', 'starterCoverage']);
    expect(data.rawLeak).toBe(false);
    // 2015-16 regular season is now PARTIALLY established by constrained reconstruction, which
    // writes only assignments forced in every feasible solution. Harden started every game he was
    // a candidate in, so his row is fully forced — coverage may legitimately reach 1 here. What
    // must still hold is that nothing is invented: starts never exceed appearances.
    expect(data.old?.starterCoverage).toBeGreaterThan(0);
    expect(data.old?.starterCoverage).toBeLessThanOrEqual(1);
    expect(data.old?.starts).toBeLessThanOrEqual(data.old?.gp);
    // The corrupted seasons' PLAYOFFS have no reconstruction, so unknown must stay unknown.
    expect(data.oldPO?.starts).toBeNull();
    expect(data.oldPO?.starterCoverage).toBe(0);
    expect(data.acceptedRS?.starts).not.toBeNull();
    expect(data.acceptedRS?.starterCoverage).toBe(1);
    expect(data.acceptedPO?.starts).not.toBeNull();
    expect(data.acceptedPO?.starterCoverage).toBe(1);

    await page.click('[data-mode="player"]');
    await page.waitForTimeout(400);
    await page.selectOption('#wsPlayerSel', String(data.playerId));
    await page.waitForTimeout(500);
    const txt = await page.$eval('#workspace', (e) => e.textContent);
    expect(txt).toContain('Historical NBA record');
    expect(txt).toContain('RS');
    expect(txt).toContain('PO');
    expect(txt).toContain('TS%');
    expect(txt).toContain('unknown is never treated as bench');
    expect(errors).toEqual([]);
  });


  test('historical game log loads on demand and preserves unknown starter status', async ({ page }) => {
    const errors = await open(page);
    const playerId = await page.evaluate(() => DATA.leagues.NBA.find((p) => p.name === 'LeBron James')?.playerId);
    expect(playerId).toBeTruthy();
    await page.click('[data-mode="player"]');
    await page.selectOption('#wsPlayerSel', String(playerId));
    await expect(page.locator('#wsLoadHistoryGames')).toBeVisible();
    await page.click('#wsLoadHistoryGames');
    await expect(page.locator('#historyGameLog tbody tr').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#historyGameLog')).toContainText('does not mean bench');
    await expect(page.locator('#historyGameLog')).toContainText('of');
    const starterValues = await page.$$eval('#historyGameLog tbody tr td:last-child', (els) => els.map((e) => e.textContent.trim()));
    expect(starterValues.length).toBeGreaterThan(0);
    expect(starterValues.every((x) => ['Yes', 'No', '—'].includes(x))).toBe(true);
    expect(errors).toEqual([]);
  });

  test('Compare exposes descriptive historical trajectory without inventing starter coverage', async ({ page }) => {
    const errors = await open(page);
    // Drive the same in-memory compare selection a user does. Filter one player at a time so the
    // test does not depend on default sort order or the table row cap.
    await page.click('[data-mode="database"]');
    for (const name of ['James Harden', 'LeBron James']) {
      await page.fill('#searchInput', name);
      const row = page.locator('#tableBody tr').filter({ hasText: name }).first();
      await expect(row).toBeVisible();
      const box = row.locator('input.compare-check');
      await expect(box).toHaveCount(1);
      await box.check();
    }
    await page.fill('#searchInput', '');
    await page.click('[data-mode="compare"]');
    await expect(page.locator('#workspace')).toContainText('Historical comparison');
    await expect(page.locator('#workspace')).toContainText('Season trajectory');
    await expect(page.locator('#workspace')).toContainText('PTS / MPG');
    await expect(page.locator('#workspace')).toContainText('Starter status is intentionally omitted');
    expect(errors).toEqual([]);
  });

  test('every preset renders and every declared field resolves', async ({ page }) => {
    const errors = await open(page);
    for (const league of ['NBA', 'GLEAGUE']) {
      if (league === 'GLEAGUE') { await page.click('.league-tab[data-league="GLEAGUE"]'); await page.waitForTimeout(500); }
      const presets = await page.$$eval('#viewPreset option', (o) => o.map((x) => x.value));
      expect(presets.length).toBeGreaterThan(8);
      for (const p of presets) {
        await setVal(page, '#viewPreset', p);
        await page.waitForTimeout(220);
        const cols = await page.$$eval('#tableHead th', (t) => t.length);
        const filled = await page.$$eval('#tableBody tr:first-child td',
          (t) => t.filter((x) => x.textContent.trim() !== '—').length);
        expect(cols, `${league}/${p} columns`).toBeGreaterThan(3);
        expect(filled, `${league}/${p} populated cells`).toBeGreaterThan(2);
      }
      await setVal(page, '#viewPreset', 'overall');
    }
    expect(errors).toEqual([]);
  });
});

test.describe('search, sort, filters', () => {
  test('accented and accentless search find the same player', async ({ page }) => {
    await open(page);
    await setVal(page, '#searchInput', 'Jokić');
    await page.waitForTimeout(200);
    const a = await page.$eval('#tableBody .player-link', (e) => e.textContent);
    await setVal(page, '#searchInput', 'Jokic');
    await page.waitForTimeout(200);
    const b = await page.$eval('#tableBody .player-link', (e) => e.textContent);
    expect(a).toContain('Joki');
    expect(b).toBe(a);
  });

  test('sorting works in both directions', async ({ page }) => {
    await open(page);
    const vals = async () => page.evaluate(() => {
      const i = [...document.querySelectorAll('#tableHead th')].findIndex((t) => t.dataset.sort === 'pts');
      return [...document.querySelectorAll('#tableBody tr')].slice(0, 10)
        .map((tr) => Number(tr.children[i]?.textContent));
    });
    await page.click('#tableHead th[data-sort="pts"]');
    await page.waitForTimeout(200);
    const desc = await vals();
    expect(desc[0]).toBeGreaterThanOrEqual(desc[1]);
    await page.click('#tableHead th[data-sort="pts"]');
    await page.waitForTimeout(200);
    const asc = await vals();
    expect(asc[0]).toBeLessThanOrEqual(asc[1]);
  });

  test('filters narrow, and a hybrid G-F satisfies a G filter', async ({ page }) => {
    await open(page);
    const all = await count(page);
    await setVal(page, '#minGp', '60');
    await page.waitForTimeout(200);
    expect(await count(page)).toBeLessThan(all);
    await setVal(page, '#minGp', '0');

    await setVal(page, '#positionFilter', 'G');
    await page.waitForTimeout(250);
    const guards = await count(page);
    const pureG = await page.evaluate(() =>
      DATA.leagues.NBA.filter((p) => p.appeared && p.positionFamily === 'G').length);
    expect(guards).toBeGreaterThan(pureG);   // G-F players are included
    await setVal(page, '#positionFilter', '');
  });

  test('numeric filter works in displayed units', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      document.getElementById('ruleMetric').value = 'ts';
      document.getElementById('ruleOp').value = '>=';
      document.getElementById('ruleValue').value = '60';
      document.getElementById('saveRuleBtn').click();
    });
    await page.waitForTimeout(250);
    const n = await count(page);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(582);
  });
});

test.describe('team scoping', () => {
  test('current NBA roster filter is distinct from 2025-26 stint scope', async ({ page }) => {
    await open(page);
    const target = await page.evaluate(() => {
      const teams = new Set([...document.querySelectorAll('#teamFilter option')].map((o) => o.value));
      const moved = DATA.leagues.NBA.find((p) => p.appeared && p.currentTeam && p.seasonTeam
        && p.currentTeam !== p.seasonTeam && teams.has(p.currentTeam) && teams.has(p.seasonTeam));
      return moved ? { id: String(moved.playerId), name: moved.name, current: moved.currentTeam, old: moved.seasonTeam } : null;
    });
    expect(target).not.toBeNull();

    await setVal(page, '#teamFilter', target.current);
    await page.waitForTimeout(250);
    let names = await page.$$eval('#tableBody .player-link', (e) => e.map((x) => x.textContent));
    expect(names).toContain(target.name);

    await setVal(page, '#teamFilter', target.old);
    await page.waitForTimeout(250);
    names = await page.$$eval('#tableBody .player-link', (e) => e.map((x) => x.textContent));
    expect(names).not.toContain(target.name);
  });

  test('team-only mode still uses a real historical stint when the current team matches one', async ({ page }) => {
    await open(page);
    const target = await page.evaluate(() => {
      const p = DATA.leagues.NBA.find((x) => x.appeared && x.currentTeam
        && (x.teams || []).some((s) => s.team === x.currentTeam) && x.teamCount > 1);
      if (!p) return null;
      const s = p.teams.find((x) => x.team === p.currentTeam);
      return { name: p.name, team: p.currentTeam, gp: s.gp };
    });
    expect(target).not.toBeNull();
    await setVal(page, '#teamFilter', target.team);
    await setVal(page, '#teamMode', 'only');
    await page.waitForTimeout(300);

    const row = await page.evaluate((name) => {
      const hdrs = [...document.querySelectorAll('#tableHead th')].map((t) => t.dataset.sort);
      const tr = [...document.querySelectorAll('#tableBody tr')].find((r) => r.textContent.includes(name));
      if (!tr) return null;
      const cells = [...tr.querySelectorAll('td')].map((t) => t.textContent.trim());
      return { gp: cells[hdrs.indexOf('gp')], grade: cells[hdrs.indexOf('grade')], ts: cells[hdrs.indexOf('ts')] };
    }, target.name);
    expect(row).not.toBeNull();
    expect(Number(row.gp.replace(/,/g, ''))).toBe(target.gp);
    expect(row.grade).toBe('—');
    expect(row.ts).toBe('—');
  });
});

test.describe('roster-only players', () => {
  test('can be included and their profile does not crash', async ({ page }) => {
    const errors = await open(page);
    const before = await count(page);
    await setCheck(page, '#includeRosterOnly', true);
    await page.waitForTimeout(250);
    expect(await count(page)).toBeGreaterThan(before);

    const opened = await page.evaluate(() => {
      const p = DATA.leagues.NBA.find((x) => x.rosterOnly);
      const link = [...document.querySelectorAll('#tableBody .player-link')]
        .find((b) => b.textContent === p.name);
      if (!link) return 'not-visible';
      link.click();
      return document.getElementById('playerDialogBody').textContent;
    });
    if (opened !== 'not-visible') expect(opened).toContain('N/A');
    expect(await page.evaluate(() =>
      DATA.leagues.NBA.filter((p) => p.rosterOnly).every((p) => p.grade === null))).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe('formula lab', () => {
  test('scores stay on 0-100 for positive and negative weights, ties share a percentile', async ({ page }) => {
    await open(page);
    const runLab = (metric, weight) => page.evaluate(([m, w]) => {
      document.getElementById('labMetric1').value = m;
      document.getElementById('labWeight1').value = String(w);
      for (const i of [2, 3, 4]) {
        document.getElementById('labMetric' + i).value = '';
        document.getElementById('labWeight' + i).value = '0';
      }
      document.getElementById('applyLab').click();
    }, [metric, weight]);

    await runLab('pts', 1); await page.waitForTimeout(350);
    let s = await page.evaluate(() => DATA.leagues.NBA.map((p) => p.labScore).filter((v) => v != null));
    expect(Math.min(...s)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...s)).toBeLessThanOrEqual(100);

    await runLab('pts', -1); await page.waitForTimeout(350);
    s = await page.evaluate(() => DATA.leagues.NBA.map((p) => p.labScore).filter((v) => v != null));
    expect(Math.min(...s)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...s)).toBeLessThanOrEqual(100);

    await runLab('blk', 1); await page.waitForTimeout(350);
    const tiesDiffer = await page.evaluate(() => {
      const by = {};
      DATA.leagues.NBA.forEach((p) => {
        if (p.blk != null && p.labScore != null) (by[p.blk] = by[p.blk] || new Set()).add(p.labScore.toFixed(6));
      });
      return Object.values(by).filter((x) => x.size > 1).length;
    });
    expect(tiesDiffer).toBe(0);
  });

  test('mixed season scopes are blocked on the G League panel', async ({ page }) => {
    await open(page);
    await page.click('.league-tab[data-league="GLEAGUE"]');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      document.getElementById('allowMixedScope').checked = false;
      document.getElementById('labMetric1').value = 'pts';
      document.getElementById('labWeight1').value = '1';
      document.getElementById('labMetric2').value = 'per';
      document.getElementById('labWeight2').value = '1';
      document.getElementById('applyLab').click();
    });
    await page.waitForTimeout(300);
    expect((await page.$eval('#labNote', (e) => e.textContent)).toLowerCase()).toContain('blocked');
  });
});

test.describe('dialogs, league switching, layout', () => {
  test('field catalog and metric definitions open', async ({ page }) => {
    await open(page);
    await page.click('#catalogBtn');
    await page.waitForTimeout(300);
    expect(await page.$eval('#catalogDialogBody', (e) => e.textContent)).toContain('Season scope');
    await page.evaluate(() => document.getElementById('catalogDialog').close());
    await page.click('#aboutBtn');
    await page.waitForTimeout(250);
    expect(await page.$eval('#metricDialogBody', (e) => e.textContent)).toContain('Counts');
    await page.evaluate(() => document.getElementById('metricDialog').close());
  });

  test('league switch with active filters, then reset', async ({ page }) => {
    const errors = await open(page);
    await setVal(page, '#minGp', '20');
    await page.click('.league-tab[data-league="GLEAGUE"]');
    await page.waitForTimeout(600);
    expect(await page.$$eval('#tableBody tr', (r) => r.length)).toBeGreaterThan(0);
    await page.click('#resetBtn');
    await page.waitForTimeout(300);
    const n = await count(page);
    expect(n).toBe(await page.evaluate(() => DATA.counts.GLEAGUE));
    expect(errors).toEqual([]);
  });

  for (const [name, width, height] of [['mobile', 390, 844], ['tablet', 820, 1180], ['desktop', 1440, 900]]) {
    test(`no horizontal body overflow at ${name} width`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const errors = await open(page);
      const o = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
        tableOverflow: getComputedStyle(document.querySelector('.table-wrap')).overflowX,
      }));
      expect(o.tableOverflow).toBe('auto');
      expect(o.scroll).toBeLessThanOrEqual(o.client + 2);
      expect(errors).toEqual([]);
    });
  }
});

/* ------------------------------------------------------------ v3.5 workspace */
test.describe('analysis workspace', () => {
  const mode = (page, m) => page.click(`[data-mode="${m}"]`);

  test('mode navigation exposes every tool and Player Comps has a top-level tab', async ({ page }) => {
    const errors = await open(page);
    const modes = await page.$$eval('[data-mode]', (b) => b.map((x) => x.dataset.mode));
    expect(modes).toEqual(['database', 'player', 'compare', 'scatter', 'similarity', 'teamfit', 'tulip']);
    expect(await page.$$eval('.site-link[data-goto="comps"]', (b) => b.length)).toBe(1);
    await page.click('.site-link[data-goto="comps"]');
    await page.waitForTimeout(350);
    expect(await page.$eval('#pageTitle', (e) => e.textContent)).toContain('Player Comparisons');
    expect(await page.$eval('.site-link[data-goto="comps"]', (e) => e.classList.contains('active'))).toBe(true);
    expect(await page.$eval('[data-mode].active', (e) => e.dataset.mode)).toBe('similarity');
    expect(await page.$$eval('#workspace .comp-hero-card', (x) => x.length)).toBeGreaterThan(0);
    await mode(page, 'teamfit');
    expect(await page.$eval('#pageTitle', (e) => e.textContent)).toBe('NBA Team Fit');
    expect(await page.$eval('#crumbs', (e) => e.textContent)).toContain('Team Fit');
    expect(errors).toEqual([]);
  });

  test('player profile shows all three grades, components, skills and archetypes', async ({ page }) => {
    const errors = await open(page);
    await mode(page, 'player');
    await page.waitForTimeout(600);
    const w = await page.$eval('#workspace', (e) => e.textContent);
    expect(w).toContain('Rate Grade');
    expect(w).toContain('Magnitude');
    expect(w).toContain('Situational splits');
    expect(await page.$$eval('#workspace .pbar', (b) => b.length)).toBeGreaterThan(15);
    expect(await page.$$eval('#workspace .arche', (b) => b.length)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('scatter reports correlation, sample size and outliers', async ({ page }) => {
    const errors = await open(page);
    await mode(page, 'scatter');
    await page.waitForTimeout(700);
    const stats = await page.$eval('#scStats', (e) => e.textContent);
    expect(stats).toMatch(/r = -?\d/);
    expect(stats).toMatch(/n = \d+/);
    expect(await page.$eval('#scOutliers', (e) => e.textContent)).toMatch(/residual/i);
    // switching axes must redraw without error
    await page.$eval('#scX', (e) => { e.value = 'pts'; e.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(500);
    expect(await page.$eval('#scStats', (e) => e.textContent)).toMatch(/r = -?\d/);
    expect(errors).toEqual([]);
  });

  test('player comps use an optimized 100% one-to-three-player blend with confidence and side-by-side detail', async ({ page }) => {
    const errors = await open(page);
    await page.click('.site-link[data-goto="comps"]');
    await page.waitForTimeout(900);

    expect(await page.$$eval('#workspace .comp-hero-card', (x) => x.length)).toBeGreaterThanOrEqual(1);
    expect(await page.$$eval('#workspace .comp-hero-card', (x) => x.length)).toBeLessThanOrEqual(3);
    expect(await page.$$eval('#workspace .comp-card', (x) => x.length)).toBeGreaterThanOrEqual(1);
    const txt = await page.$eval('#workspace', (e) => e.textContent);
    expect(txt).toContain('blend composition');
    expect(txt).toContain('BLEND CONFIDENCE');
    for (const needle of ['Height', 'Weight', 'Wingspan', 'Standing reach', 'PTS / 36', 'FGA / 36',
      'Usage', 'AST%', 'AST / TO', 'True shooting', 'eFG%', '3PA share', 'FT rate',
      'STL / 36', 'BLK / 36', 'DREB%', 'OREB%', 'REB%', 'Net rating']) {
      expect(txt, 'missing side-by-side metric: ' + needle).toContain(needle);
    }

    // Literal typed-search path: autocomplete suggestions + team/position filters, no mega-select.
    expect(await page.$('#simSearch')).not.toBeNull();
    expect(await page.$('#simTeam')).not.toBeNull();
    expect(await page.$('#simPosition')).not.toBeNull();
    expect(await page.$('#simSel')).toBeNull();
    const typed = await page.evaluate(() => {
      const ids = new Set(Object.keys(DATA.analysis.playerComps.NBA));
      const p = DATA.leagues.NBA.find((x, i) => i > 5 && ids.has(String(x.playerId)) && x.appeared);
      return { name: p.name, team: p.currentTeam || p.team, position: p.position };
    });
    await page.fill('#simSearch', typed.name.slice(0, Math.max(3, typed.name.length - 2)));
    await page.waitForTimeout(150);
    expect(await page.$$eval('#simSuggestions [data-sim-pick]', (x) => x.length)).toBeGreaterThan(0);
    await page.fill('#simSearch', typed.name);
    await page.press('#simSearch', 'Enter');
    await page.waitForTimeout(500);
    expect(await page.inputValue('#simSearch')).toContain(typed.name);
    expect(await page.$eval('#workspace', (e) => e.textContent)).toContain(typed.name);

    const props = await page.evaluate(() => {
      const meta = DATA.analysis.playerCompsMeta;
      const groups = {
        NBA: Object.entries(DATA.analysis.playerComps.NBA),
        GLEAGUE: Object.entries(DATA.analysis.playerComps.GLEAGUE),
      };
      let badCount = 0, badScore = 0, badBlend = 0, badConfidence = 0, self = 0, duplicatePlayers = 0, badLeague = 0;
      let nearThird = 0, totalSets = 0;
      const patterns = new Set(), topShares = [], allScores = [];
      for (const [league, entries] of Object.entries(groups)) {
        for (const [targetId, set] of entries) {
          totalSets++;
          if ((set.top3 || []).length < 1 || (set.top3 || []).length > 3 || (set.blend || []).length !== (set.top3 || []).length) badCount++;
          if (new Set((set.top3 || []).map((x) => String(x.playerId))).size !== (set.top3 || []).length) duplicatePlayers++;
          const sum = (set.blend || []).reduce((a, x) => a + x.share, 0);
          if (sum !== 100 || (set.blend || []).some((x) => !(x.share >= 0 && x.share <= 100))) badBlend++;
          if (!(set.blendConfidence >= 0 && set.blendConfidence <= 100)) badConfidence++;
          const shares = (set.blend || []).map((x) => x.share);
          if (shares.length === 3) {
            patterns.add(shares.join('/'));
            topShares.push(Math.max(...shares));
            if (Math.max(...shares) - Math.min(...shares) <= 4) nearThird++;
          }
          for (const comp of set.top3 || []) {
            allScores.push(comp.similarity);
            if (!(comp.similarity >= 0 && comp.similarity <= 100)) badScore++;
            if (String(comp.playerId) === String(targetId)) self++;
            if (comp.league !== league) badLeague++;
          }
        }
      }
      return {
        meta, nbaN: groups.NBA.length, gleagueN: groups.GLEAGUE.length,
        badCount, badScore, badBlend, badConfidence, self, duplicatePlayers, badLeague,
        totalSets, nearThird, distinctPatterns: patterns.size,
        topShareMax: Math.max(...topShares), topShareMin: Math.min(...topShares),
        minScore: Math.min(...allScores), maxScore: Math.max(...allScores)
      };
    });
    expect(props.nbaN).toBeGreaterThan(500);
    expect(props.gleagueN).toBeGreaterThan(500);
    expect(props.badCount).toBe(0);
    expect(props.badScore).toBe(0);
    expect(props.badBlend).toBe(0);
    expect(props.badConfidence).toBe(0);
    expect(props.self).toBe(0);
    expect(props.duplicatePlayers).toBe(0);
    expect(props.badLeague).toBe(0);
    expect(props.distinctPatterns).toBeGreaterThan(20);
    expect(props.nearThird / props.totalSets).toBeLessThan(0.75);
    expect(props.topShareMax).toBeGreaterThanOrEqual(40);
    expect(props.maxScore - props.minScore).toBeGreaterThan(25);
    expect(props.meta.sameLeagueOnly).toBe(true);
    expect(props.meta.physicalWeight).toBeCloseTo(0.20, 6);
    expect(props.meta.positionGate).toBe(false);
    expect(props.meta.blendMethod).toContain('convex reconstruction');
    expect(errors).toEqual([]);
  });


  test('team fit is bounded, explained, and separate from quality', async ({ page }) => {
    const errors = await open(page);
    await mode(page, 'teamfit');
    await page.waitForTimeout(700);
    expect(await page.$eval('#workspace', (e) => e.textContent)).toContain('/100');
    expect(await page.$eval('#workspace', (e) => e.textContent)).toContain('not');

    const t = await page.evaluate(() => {
      const teams = DATA.analysis.teams.NBA;
      const all = Object.values(teams);
      const scores = all.flatMap((x) => x.topFits.map((f) => f.score));
      const needs = all.flatMap((x) => Object.values(x.needs).map((n) => n.need));
      // A lower-graded player outranking a higher-graded one on fit proves the two are distinct.
      let inversion = false;
      for (const x of all) {
        for (let i = 1; i < Math.min(20, x.topFits.length); i++) {
          if (x.topFits[i - 1].grade < x.topFits[i].grade) { inversion = true; break; }
        }
        if (inversion) break;
      }
      return { minScore: Math.min(...scores), maxScore: Math.max(...scores),
               minNeed: Math.min(...needs), maxNeed: Math.max(...needs),
               teams: all.length, inversion };
    });
    expect(t.minScore).toBeGreaterThanOrEqual(0);
    expect(t.maxScore).toBeLessThanOrEqual(100);
    expect(t.minNeed).toBeGreaterThanOrEqual(0);
    expect(t.maxNeed).toBeLessThanOrEqual(100);
    expect(t.teams).toBeGreaterThan(20);
    expect(t.inversion).toBe(true);
    expect(errors).toEqual([]);
  });

  test('compare uses the selected players and marks winners', async ({ page }) => {
    const errors = await open(page);
    await page.$$eval('[data-compare]', (b) => b.slice(0, 3).forEach((x) => {
      x.checked = true; x.dispatchEvent(new Event('change'));
    }));
    await mode(page, 'compare');
    await page.waitForTimeout(500);
    expect(await page.$$eval('#workspace tbody tr', (r) => r.length)).toBeGreaterThan(10);
    expect(await page.$$eval('#workspace .winner', (w) => w.length)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('G League translation is exploratory and carries a sample size', async ({ page }) => {
    await open(page);
    const tr = await page.evaluate(() => {
      const t = DATA.analysis.translation;
      const gl = DATA.leagues.GLEAGUE.find((p) => p.appeared && p.nbaTranslation?.pts);
      return { sample: t.crossoverSample, caveat: t.caveat,
               n: gl?.nbaTranslation.pts.basedOn,
               ordered: gl && gl.nbaTranslation.pts.low <= gl.nbaTranslation.pts.estimate
                        && gl.nbaTranslation.pts.estimate <= gl.nbaTranslation.pts.high };
    });
    expect(tr.sample).toBeGreaterThan(50);
    expect(tr.caveat.toLowerCase()).toContain('not enough');
    expect(tr.n).toBeGreaterThan(7);
    expect(tr.ordered).toBe(true);     // low <= estimate <= high
  });

  test('workspace holds up at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await open(page);
    for (const m of ['player', 'scatter', 'similarity', 'teamfit']) {
      await mode(page, m);
      await page.waitForTimeout(500);
      const o = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
      }));
      expect(o.scroll, `${m} overflow`).toBeLessThanOrEqual(o.client + 2);
    }
    expect(errors).toEqual([]);
  });
});

/* ---------------------------------------------------------------- TULIP v0.1 */
test.describe('TULIP', () => {
  test('card shows the scenario, support, tiers and both reads', async ({ page }) => {
    const errors = await open(page);
    await page.click('[data-mode="tulip"]');
    await page.waitForTimeout(900);
    const txt = await page.$eval('#workspace', (e) => e.textContent);
    // Renamed: only TULIP Capacity V1 carries the user-facing TULIP name now. This workspace is
    // the comparables-based Role Value tool, which is a different question entirely.
    for (const needle of ['Role Value support', 'Evidence tier', 'Role-Scale Response',
      'PLAYER / LEAGUE READ', 'TEAM DECISION READ', 'Candidate projection', 'Median team-mate',
      'Lineup adjustment', 'TULIP Evidence v0.1']) {
      expect(txt, `missing: ${needle}`).toContain(needle);
    }
    // The two reads must not be merged into one score.
    expect(txt).toContain('not context-free player quality');
    expect(await page.$('#tuCanvas')).not.toBeNull();
    expect(errors).toEqual([]);
  });

  test('insufficient evidence is distinguished from predicted decline', async ({ page }) => {
    await open(page);
    await page.click('[data-mode="tulip"]');
    await page.waitForTimeout(900);
    expect((await page.$eval('#tuLegend', (e) => e.textContent)).toLowerCase())
      .toContain('insufficient evidence');
    // Select a band the model abstains on, if the current player has one.
    const picked = await page.evaluate(() => {
      const sel = document.getElementById('tuTarget');
      const o = [...sel.options].find((x) => /no evidence/.test(x.textContent));
      if (!o) return false;
      sel.value = o.value; sel.dispatchEvent(new Event('change')); return true;
    });
    if (picked) {
      await page.waitForTimeout(700);
      const t = await page.$eval('#workspace', (e) => e.textContent);
      expect(t).toContain('INSUFFICIENT EVIDENCE');
      expect(t.toLowerCase()).toMatch(/not a prediction of decline|not.*prediction of decline/);
    }
  });

  test('abstention reasons reconcile and residual bias is disclosed', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const rules = [[/Already plays/, 'large'], [/only .* minutes above/, 'close'],
        [/comparable players have played/, 'few'], [/Support .* below/, 'support'],
        [/do not cover this candidate/, 'nosupport']];
      const out = {};
      for (const lg of ['NBA', 'GLEAGUE']) {
        const cards = DATA.leagues[lg].filter((p) => p.appeared && p.tulip);
        const ab = cards.filter((p) => p.tulip.card.abstain);
        let matched = 0;
        for (const p of ab) if (rules.some(([re]) => re.test(p.tulip.card.reason || ''))) matched++;
        out[lg] = { cards: cards.length, abstained: ab.length, matched };
      }
      out.bias = DATA.tulipMeta?.knownResidualBias?.starterContext || null;
      out.forecast = DATA.tulipMeta?.historical?.forecastAvailable;
      out.tiers = DATA.tulipMeta?.evidenceTiers || {};
      return out;
    });
    for (const lg of ['NBA', 'GLEAGUE']) {
      expect(r[lg].matched, `${lg} unclassified abstention reasons`).toBe(r[lg].abstained);
    }
    // The residual starter bias must be shipped, not silently dropped.
    expect(r.bias).not.toBeNull();
    expect(r.bias.identified).toBe(false);
    // No Forecast may be advertised until history exists.
    expect(r.forecast).toBe(false);
    expect(r.tiers.A.available).toBe(false);
    expect(r.tiers.C.available).toBe(false);
    expect(r.tiers.B.available).toBe(true);
  });

  test('rotation delta keeps lineup adjustment null and both deltas present', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const withRot = DATA.leagues.NBA.filter((p) => p.appeared && p.tulip
        && !p.tulip.card.abstain && p.tulip.card.rotation && !p.tulip.card.rotation.abstain);
      const bad = withRot.filter((p) => p.tulip.card.rotation.lineupInteractionAdjustment !== null
        || p.tulip.card.rotation.decomposition?.lineupAdjustment !== null);
      const missing = withRot.filter((p) => p.tulip.card.rotation.leagueReferencedDelta === undefined
        || p.tulip.card.rotation.neutralRotationDelta === undefined);
      return { n: withRot.length, badLineup: bad.length, missingDelta: missing.length };
    });
    expect(r.n).toBeGreaterThan(50);
    expect(r.badLineup).toBe(0);      // never guessed without lineup data
    expect(r.missingDelta).toBe(0);   // both questions always answered
  });
});

test.describe('TULIP column', () => {
  test('TULIP is a sortable column on the default view and abstentions never rank as zero', async ({ page }) => {
    const errors = await open(page);

    // Present on the DEFAULT preset, not buried in a secondary view.
    const headers = await page.$$eval('thead th', (ths) => ths.map((t) => t.innerText.trim().toUpperCase()));   // labels are sentence case on screen
    // The default view now leads with TULIP Beta: how many more/fewer MPG a player should get.
    // Projected Role MPG remains a separate product with its own preset and must NOT be called TULIP.
    expect(headers).toContain('TULIP');
    expect(headers).toContain('RECOMMENDED MPG');
    expect(headers).not.toContain('TULIP CAPACITY');
    expect(headers).not.toContain('TULIP MPG');   // legacy presentation must be gone
    expect(await page.$eval('#viewPreset', (s) => s.value)).toBe('overall');

    const idx = headers.indexOf('TULIP');
    const readCol = () => page.$$eval('#tableBody tr', (rows, i) => rows.map((r) => {
      const c = r.querySelectorAll('td');
      return { name: (c[3]?.innerText || '').split('\n')[0].trim(), tulip: (c[i]?.innerText || '').trim() };
    }), idx);

    // Click by column index: the header text gains a sort arrow after the first click, so a
    // text-matching locator stops resolving. The FIRST click on a numeric column sorts
    // descending, which is what we want to check first.
    const th = page.locator('thead th').nth(idx);
    await th.click();
    await page.waitForTimeout(500);

    const desc = await readCol();
    const nums = desc.map((r) => Number(r.tulip)).filter((n) => Number.isFinite(n));
    expect(nums.length).toBeGreaterThan(3);
    // Monotonically non-increasing among the values that exist.
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeLessThanOrEqual(nums[i - 1]);
    // The top of a descending sort must be a real value, never a blank abstention.
    expect(desc[0].tulip).not.toBe('—');

    // Ascending: abstentions must STILL sort last. If a blank were coerced to 0 it would surface
    // at the top here, ranking a player TULIP refused to judge as though it scored him zero.
    await th.click();
    await page.waitForTimeout(500);
    const asc = await readCol();
    expect(asc[0].tulip).not.toBe('—');
    // TULIP is a SIGNED reallocation, so an ascending sort legitimately starts negative. The
    // invariant under test: the top is a REAL value, not an abstention coerced to zero.
    const ascNums = asc.map((r) => Number(r.tulip)).filter((n) => Number.isFinite(n));
    expect(ascNums.length).toBeGreaterThan(3);
    expect(ascNums[0]).toBeLessThan(0);
    for (let i = 1; i < ascNums.length; i++) expect(ascNums[i]).toBeGreaterThanOrEqual(ascNums[i - 1]);
    // and no abstention is ranked ABOVE a real prediction. (Checking the literal last rows is not
    // reliable — the table paginates — but ordering within what IS rendered is.)
    const firstBlank = asc.findIndex((r) => r.tulip === '—');
    if (firstBlank !== -1) {
      const anyRealAfterBlank = asc.slice(firstBlank).some((r) => Number.isFinite(Number(r.tulip)) && r.tulip !== '—');
      expect(anyRealAfterBlank).toBe(false);
    }

    expect(errors).toEqual([]);
  });

  test('a dedicated Role Value preset exposes the projection fields', async ({ page }) => {
    const errors = await open(page);
    await page.selectOption('#viewPreset', 'tulip');   // the Role Value preset
    await page.waitForTimeout(500);
    const headers = await page.$$eval('thead th', (ths) => ths.map((t) => t.innerText.trim().toUpperCase()));   // labels are sentence case on screen
    for (const h of ['ROLE VALUE', 'ROLE VALUE NEUTRAL', 'ROLE VALUE PROJ', 'ROLE VALUE SUPPORT', 'EVIDENCE TIER', 'ROLE VERDICT']) {
      expect(headers).toContain(h);
    }
    expect(errors).toEqual([]);
  });
});

test.describe('Sort control', () => {
  test('a Sort by dropdown sorts the whole database, including by TULIP', async ({ page }) => {
    const errors = await open(page);

    // The control must exist in the filter panel — not require discovering that column headers
    // are clickable and scrolling sideways through 24 columns to find one.
    const options = await page.$$eval('#sortField option', (os) => os.map((o) => o.text.trim()));
    expect(options).toContain('TULIP');
    expect(options).toContain('Grade');

    await page.selectOption('#sortField', 'tb.tulip');
    await page.selectOption('#sortOrder', '-1');
    await page.waitForTimeout(500);

    const headers = await page.$$eval('thead th', (ths) => ths.map((t) => t.innerText.trim().toUpperCase()));   // labels are sentence case on screen
    // The header gains a sort arrow once sorted, so match on prefix rather than equality.
    const idx = headers.findIndex((h) => h.startsWith('TULIP'));
    // A missing header would give -1, and Playwright's .nth(-1) silently selects the LAST column,
    // which turns a broken lookup into a confusing assertion failure elsewhere.
    expect(idx).toBeGreaterThan(-1);
    const read = () => page.$$eval('#tableBody tr', (rows, i) => rows.map((r) => {
      const c = r.querySelectorAll('td');
      return (c[i]?.innerText || '').trim();
    }), idx);

    const desc = (await read()).map(Number).filter(Number.isFinite);
    expect(desc.length).toBeGreaterThan(3);
    for (let i = 1; i < desc.length; i++) expect(desc[i]).toBeLessThanOrEqual(desc[i - 1]);

    // Order dropdown flips direction, and abstentions still never surface at the top.
    await page.selectOption('#sortOrder', '1');
    await page.waitForTimeout(500);
    const ascCells = await read();
    expect(ascCells[0]).not.toBe('—');
    const asc = ascCells.map(Number).filter(Number.isFinite);
    for (let i = 1; i < asc.length; i++) expect(asc[i]).toBeGreaterThanOrEqual(asc[i - 1]);

    // The dropdown and the clickable header are one state, not two.
    await page.locator('thead th').nth(idx).click();
    await page.waitForTimeout(500);
    expect(await page.$eval('#sortField', (s) => s.value)).toBe('tb.tulip');
    expect(await page.$eval('#sortOrder', (s) => s.value)).toBe('-1');

    expect(errors).toEqual([]);
  });
});
