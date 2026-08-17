/**
 * End-to-end functional test for the built standalone page.
 *
 * A passing data audit does not prove the application works. This drives the real interface —
 * filters, sorts, the lab, exports, dialogs, league switching, responsive width — and returns a
 * pass/fail list. Paste into the page console, or run via an automation harness:
 *
 *   const results = await window.__runAppTests();
 */
window.__runAppTests = async function runAppTests() {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, cond, detail = '') =>
    results.push({ name, pass: !!cond, detail: String(detail).slice(0, 120) });
  const rowsNow = () => document.querySelectorAll('#tableBody tr').length;
  const firstName = () => document.querySelector('#tableBody .player-link')?.textContent || '';
  const count = () => Number($('resultCount').textContent.replace(/,/g, ''));

  for (let i = 0; i < 150 && !document.querySelector('#tableBody tr td'); i++) await sleep(200);

  // --- load
  check('NBA tab shows appeared count', $('nbaCount').textContent === String(DATA.counts.NBA), $('nbaCount').textContent);
  check('G League tab shows appeared count', $('gCount').textContent === String(DATA.counts.GLEAGUE), $('gCount').textContent);
  check('table rendered', rowsNow() > 0, rowsNow());
  check('complete NBA field set present',
    new Set(DATA.leagues.NBA.flatMap((p) => Object.keys(p.stats || {}))).size > 550);
  check('field catalog present', Object.keys(DATA.fieldCatalog || {}).length > 100);
  check('provenance present', !!DATA.provenance?.sources?.length);

  // --- search
  $('searchInput').value = 'Jokić'; $('searchInput').dispatchEvent(new Event('input')); await sleep(150);
  check('accented search finds player', /Joki/.test(firstName()), firstName());
  $('searchInput').value = 'Jokic'; $('searchInput').dispatchEvent(new Event('input')); await sleep(150);
  check('accentless search finds the same player', /Joki/.test(firstName()), firstName());
  $('searchInput').value = ''; $('searchInput').dispatchEvent(new Event('input')); await sleep(100);

  // --- sorting both directions.
  // Resolve the column position from the header rather than hardcoding an index: presets change,
  // and an earlier version of this test silently read the neighbouring column instead.
  const headers = () => [...document.querySelectorAll('#tableHead th')];
  const colIndex = (key) => headers().findIndex((t) => t.dataset.sort === key);
  const colValues = (key) => {
    const i = colIndex(key);
    return [...document.querySelectorAll('#tableBody tr')].map((tr) => Number(tr.children[i]?.textContent));
  };
  const th = headers().find((t) => t.dataset.sort === 'pts');
  th.click(); await sleep(150);
  const desc = colValues('pts');
  check('sort descending', desc[0] >= desc[1], `${desc[0]} >= ${desc[1]}`);
  th.click(); await sleep(150);
  const asc = colValues('pts');
  check('sort ascending', asc[0] <= asc[1], `${asc[0]} <= ${asc[1]}`);

  // --- filters
  $('positionFilter').value = 'G'; $('positionFilter').dispatchEvent(new Event('change')); await sleep(150);
  const guards = count();
  check('position family filter narrows', guards > 0 && guards < 582, guards);
  $('positionFilter').value = ''; $('positionFilter').dispatchEvent(new Event('change'));

  $('minGp').value = 60; $('minGp').dispatchEvent(new Event('change')); await sleep(150);
  check('min games filter narrows', count() < 582, count());
  $('minGp').value = 0; $('minGp').dispatchEvent(new Event('change'));

  // --- team stint scoping
  $('teamFilter').value = 'CLE'; $('teamFilter').dispatchEvent(new Event('change'));
  $('teamMode').value = 'season'; $('teamMode').dispatchEvent(new Event('change')); await sleep(150);
  const seasonRows = count();
  $('teamMode').value = 'only'; $('teamMode').dispatchEvent(new Event('change')); await sleep(200);
  check('team-only mode keeps the same roster', count() === seasonRows, `${seasonRows} -> ${count()}`);
  check('team-only mode is announced', /stint/.test($('sortLabel').textContent), $('sortLabel').textContent);
  $('teamMode').value = 'season'; $('teamFilter').value = ''; $('teamFilter').dispatchEvent(new Event('change'));

  // --- roster-only players
  const before = count();
  if ($('includeRosterOnly')) {
    $('includeRosterOnly').checked = true; $('includeRosterOnly').dispatchEvent(new Event('change')); await sleep(200);
    check('roster-only players can be included', count() >= before, `${before} -> ${count()}`);
    $('includeRosterOnly').checked = false; $('includeRosterOnly').dispatchEvent(new Event('change'));
  }

  // --- numeric rule in displayed units
  $('ruleMetric').value = 'ts'; $('ruleOp').value = '>='; $('ruleValue').value = '60';
  $('saveRuleBtn').click(); await sleep(200);
  check('TS% >= 60 filter works in displayed units', count() > 0 && count() < 582, count());
  document.querySelector('[data-rule-remove]')?.click(); await sleep(150);

  // --- formula lab
  $('labMetric1').value = 'pts'; $('labWeight1').value = '1';
  $('labMetric2').value = ''; $('labWeight2').value = '0';
  $('labMetric3').value = ''; $('labWeight3').value = '0';
  $('labMetric4').value = ''; $('labWeight4').value = '0';
  $('labCohort').value = 'league'; $('applyLab').click(); await sleep(300);
  const labScores = DATA.leagues.NBA.map((p) => p.labScore).filter((v) => v != null);
  check('lab produces scores', labScores.length > 0, labScores.length);
  check('lab scores stay on 0-100', Math.min(...labScores) >= 0 && Math.max(...labScores) <= 100,
    `${Math.min(...labScores).toFixed(1)}..${Math.max(...labScores).toFixed(1)}`);

  $('labWeight1').value = '-1'; $('applyLab').click(); await sleep(300);
  const neg = DATA.leagues.NBA.map((p) => p.labScore).filter((v) => v != null);
  check('negative weight stays on 0-100', Math.min(...neg) >= 0 && Math.max(...neg) <= 100,
    `${Math.min(...neg).toFixed(1)}..${Math.max(...neg).toFixed(1)}`);

  // ties must share a percentile
  $('labMetric1').value = 'blk'; $('labWeight1').value = '1'; $('applyLab').click(); await sleep(300);
  const byVal = {};
  DATA.leagues.NBA.forEach((p) => {
    if (p.blk != null && p.labScore != null) (byVal[p.blk] = byVal[p.blk] || new Set()).add(p.labScore.toFixed(6));
  });
  check('tied values share a lab percentile',
    Object.values(byVal).every((s) => s.size === 1),
    Object.values(byVal).filter((s) => s.size > 1).length + ' groups differ');

  // mixed-scope guard
  if ($('allowMixedScope')) {
    $('allowMixedScope').checked = false;
    $('labMetric1').value = 'pts'; $('labWeight1').value = '1';
    $('labMetric2').value = 'per'; $('labWeight2').value = '1';
    $('applyLab').click(); await sleep(250);
    const blocked = /blocked/i.test($('labNote').textContent);
    check('mixed season scopes are guarded (G League only)', league !== 'GLEAGUE' || blocked, $('labNote').textContent.slice(0, 80));
    $('labMetric2').value = ''; $('labWeight2').value = '0'; $('applyLab').click(); await sleep(150);
  }

  // --- dialogs
  document.querySelector('#tableBody .player-link').click(); await sleep(300);
  check('player detail opens', $('playerDialog').open);
  check('player detail shows cohort ranks', /Among|On /.test($('playerDialogBody').textContent));
  $('playerDialog').close();

  $('catalogBtn').click(); await sleep(250);
  check('field catalog opens', $('catalogDialog').open);
  check('field catalog lists fields', /Season scope/.test($('catalogDialogBody').textContent));
  $('catalogDialog').close();

  $('aboutBtn').click(); await sleep(200);
  check('metric definitions open', $('metricDialog').open);
  $('metricDialog').close();

  // compare
  const boxes = [...document.querySelectorAll('[data-compare]')].slice(0, 2);
  boxes.forEach((b) => { b.checked = true; b.dispatchEvent(new Event('change')); });
  await sleep(150);
  check('compare enables with two players', !$('compareBtn').disabled);
  $('compareBtn').click(); await sleep(250);
  check('compare dialog opens', $('compareDialog').open);
  $('compareDialog').close();
  $('clearCompareBtn').click(); await sleep(100);

  // --- all raw stats
  $('viewPreset').value = 'all'; $('viewPreset').dispatchEvent(new Event('change')); await sleep(700);
  check('all-raw view exposes the full column set',
    document.querySelectorAll('#tableHead th').length > 500,
    document.querySelectorAll('#tableHead th').length);
  $('viewPreset').value = 'overall'; $('viewPreset').dispatchEvent(new Event('change')); await sleep(200);

  // --- league switch with filters active, then reset
  $('minGp').value = 20; $('minGp').dispatchEvent(new Event('change')); await sleep(120);
  document.querySelectorAll('.league-tab')[1].click(); await sleep(500);
  check('league switch survives active filters', rowsNow() > 0, rowsNow());
  check('G League panel loaded', $('resultCount').textContent !== '0');
  $('resetBtn').click(); await sleep(200);
  check('reset restores full list', count() === DATA.counts.GLEAGUE, count());
  document.querySelectorAll('.league-tab')[0].click(); await sleep(400);

  // --- layout
  check('table scrolls inside its own container',
    getComputedStyle(document.querySelector('.table-wrap')).overflowX === 'auto');
  check('no horizontal body overflow at this width',
    document.documentElement.clientWidth === 0 ||
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
    `${document.documentElement.scrollWidth} vs ${document.documentElement.clientWidth}`);

  const failed = results.filter((r) => !r.pass);
  return { total: results.length, passed: results.length - failed.length, failed, results };
};
