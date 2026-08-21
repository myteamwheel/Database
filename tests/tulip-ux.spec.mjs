// Regression coverage for the TULIP Beta explanation/product-polish pass.
//
// This suite deliberately treats the shipped model payload as immutable. The requested work is
// presentation only: explanatory copy and roster-table controls must never recompute TULIP.
import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + path.join(ROOT, 'public/standalone.html');
const DATA_PATH = path.join(ROOT, 'public/data.json');

// Frozen at the verified handoff commit 645a2519a9fc2751bbc95d5417433e5d174e7130.
// The digest covers every TULIP Beta value, constraint, support classification and abstention in
// both leagues, while allowing presentation-only fields to be added elsewhere in the payload.
const BASELINE_TULIP_DIGEST = '7024c8717b5d41427195377475a8053e4a2a5796ad24514ddf85e57fa5603970';
const TULIP_FIELDS = [
  'tulip', 'currentMpg', 'recommendedMpg', 'valueGap', 'valueGapSd', 'shrunkBpm',
  'supportedCeiling', 'evidenceFactor', 'evidenceTier', 'confidence', 'abstain', 'status', 'reason',
];

function tulipDigest(data) {
  const rows = Object.entries(data.leagues).flatMap(([league, players]) => players.map((player) => {
    const beta = player.tulipBeta || {};
    return [league, String(player.playerId), ...TULIP_FIELDS.map((key) => beta[key] ?? null)];
  })).sort((a, b) => (`${a[0]}\0${a[1]}`).localeCompare(`${b[0]}\0${b[1]}`));
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function open(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  await page.goto(PAGE);
  await page.waitForFunction(() => document.querySelector('#tableBody tr td'), null, { timeout: 60000 });
  return errors;
}

const signed1 = (value) => `${value > 0 ? '+' : ''}${Number(value).toFixed(1)}`;
const signed2 = (value) => `${value > 0 ? '+' : ''}${Number(value).toFixed(2)}`;

async function playerWith(page, direction) {
  return page.evaluate((wanted) => {
    const scored = DATA.leagues.NBA.filter((player) => player.tulipBeta && !player.tulipBeta.abstain);
    const sign = wanted === 'gaining' ? 1 : wanted === 'losing' ? -1 : 0;
    const candidates = scored.filter((player) => Math.sign(player.tulipBeta.tulip) === sign);

    // For the positive explanation, exercise all three visibly different path values where the
    // current payload permits it. This stays data-driven and never names or special-cases a player.
    if (sign > 0) {
      candidates.sort((a, b) => {
        const constrained = (player) => {
          const c = player.tulipBeta;
          const raw = c.valueGapSd * 6.6;
          return Math.min(raw * c.evidenceFactor, Math.max(0, c.supportedCeiling - c.currentMpg));
        };
        return Math.abs(constrained(b) - b.tulipBeta.tulip)
          - Math.abs(constrained(a) - a.tulipBeta.tulip);
      });
    }
    const player = candidates[0];
    if (!player) return null;
    const c = player.tulipBeta;
    const raw = Number.isFinite(c.rawSignalDelta) ? c.rawSignalDelta : c.valueGapSd * 6.6;
    const constrained = Number.isFinite(c.constrainedDelta) ? c.constrainedDelta : raw > 0
      ? Math.min(raw * c.evidenceFactor, Math.max(0, c.supportedCeiling - c.currentMpg))
      : Math.max(raw, -Math.max(0, c.currentMpg - 6));
    return {
      playerId: String(player.playerId),
      team: player.team,
      currentMpg: c.currentMpg,
      recommendedMpg: c.recommendedMpg,
      tulip: c.tulip,
      valueGapSd: c.valueGapSd,
      supportedCeiling: c.supportedCeiling,
      evidenceFactor: c.evidenceFactor,
      evidenceTier: c.evidenceTier,
      raw,
      constrained,
    };
  }, direction);
}

async function showPlayer(page, player) {
  await page.evaluate((playerId) => openPlayer(playerId), player.playerId);
  await expect(page.locator('#playerDialog')).toHaveAttribute('open', '');
  return page.locator('.tulip-explanation');
}

test.describe('TULIP UX keeps the verified model frozen', () => {
  test('all existing TULIP outputs and the separate Projected Role model hash are unchanged', async () => {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    expect(tulipDigest(data)).toBe(BASELINE_TULIP_DIGEST);
    expect(data.tulipCapacityMeta?.cardSha256).toBe('96cb2f34c6cd06c3');
  });

  test('filtering and sorting the roster table never mutate the in-memory model payload', async ({ page }) => {
    const errors = await open(page);
    const before = await page.evaluate(() => JSON.stringify(Object.entries(DATA.leagues)
      .flatMap(([league, players]) => players.map((player) => [
        league, String(player.playerId), player.tulipBeta || null,
      ]))));

    const team = await page.evaluate(() => [...new Set(DATA.leagues.NBA.map((player) => player.team))]
      .find((candidate) => {
        const roster = DATA.leagues.NBA.filter((player) => player.team === candidate
          && player.tulipBeta && !player.tulipBeta.abstain);
        return roster.some((player) => player.tulipBeta.tulip > 0)
          && roster.some((player) => player.tulipBeta.tulip < 0)
          && roster.some((player) => player.tulipBeta.tulip === 0);
      }));
    expect(team).toBeTruthy();
    await page.evaluate((selectedTeam) => openTeamAllocation(selectedTeam), team);
    for (const filter of ['gaining', 'losing', 'nochange', 'all']) {
      await page.locator(`[data-ta-filter="${filter}"]`).click();
    }
    for (const sort of ['current', 'recommended', 'support', 'tulip']) {
      await page.locator('[data-ta-sort]').selectOption(sort);
    }

    const after = await page.evaluate(() => JSON.stringify(Object.entries(DATA.leagues)
      .flatMap(([league, players]) => players.map((player) => [
        league, String(player.playerId), player.tulipBeta || null,
      ]))));
    expect(after).toBe(before);
    expect(errors).toEqual([]);
  });
});

test.describe('Why this TULIP?', () => {
  test('a gaining player exposes the actual signal, constraint and balanced-final path', async ({ page }) => {
    const errors = await open(page);
    const player = await playerWith(page, 'gaining');
    expect(player).not.toBeNull();
    const explanation = await showPlayer(page, player);

    await expect(explanation).toContainText(`Why TULIP recommends ${signed1(player.tulip)} MPG`);
    const path = explanation.locator('.tulip-constraint-path');
    await expect(path).toBeVisible();
    await expect(path.locator('.tulip-constraint-step')).toHaveCount(3);
    const pathText = await path.innerText();
    expect(pathText).toMatch(/raw (?:tulip )?(?:signal|desire)/i);
    expect(pathText).toMatch(/role|workload/i);
    expect(pathText).toMatch(/roster[- ]balanced final tulip/i);
    expect(pathText).toContain(signed1(player.raw));
    expect(pathText).toContain(signed1(player.constrained));
    expect(pathText).toContain(signed1(player.tulip));

    const text = await explanation.innerText();
    expect(text).toContain(signed2(player.valueGapSd));
    expect(text).toContain(player.currentMpg.toFixed(1));
    expect(text).toContain(player.recommendedMpg.toFixed(1));
    expect(text).toContain(player.supportedCeiling.toFixed(1));
    expect(text).toMatch(/strong support|moderate support|limited support|very limited|insufficient support/i);
    expect(text).toMatch(new RegExp(`tier\\s+${player.evidenceTier}`, 'i'));
    expect(text).toMatch(new RegExp(`factor\\s+${player.evidenceFactor.toFixed(2)}`, 'i'));
    expect(text).toMatch(/positive expansion/i);
    expect(text).toMatch(/not (?:a )?probability/i);
    await expect(page.locator('#playerDialogBody')).toContainText(/experimental beta/i);
    expect(text).not.toMatch(/optimal rotation|proven best allocation|expected wins added|will increase wins|should definitely play|confidence of correctness/i);
    expect(errors).toEqual([]);
  });

  test('a losing player explains released minutes without implying Role Evidence caused the cut', async ({ page }) => {
    const errors = await open(page);
    const player = await playerWith(page, 'losing');
    expect(player).not.toBeNull();
    const explanation = await showPlayer(page, player);
    const text = await explanation.innerText();

    expect(text).toContain(`Why TULIP recommends ${signed1(player.tulip)} MPG`);
    expect(text).toContain(player.currentMpg.toFixed(1));
    expect(text).toContain(player.recommendedMpg.toFixed(1));
    expect(text).toMatch(/available|returned|higher-ranked teammates|surrender/i);
    expect(text).not.toMatch(/role evidence|tier\s+[A-D]|factor\s+0?\./i);
    await expect(explanation.locator('.tulip-constraint-step')).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test('a scored zero remains a real no-change recommendation, not an abstention', async ({ page }) => {
    const errors = await open(page);
    const player = await playerWith(page, 'nochange');
    expect(player).not.toBeNull();
    const explanation = await showPlayer(page, player);
    const text = await explanation.innerText();

    expect(text).toContain('Why TULIP recommends 0.0 MPG');
    expect(text).toMatch(/no (?:displayed )?change|about the same/i);
    expect(text).not.toMatch(/no recommendation|abstain/i);
    expect(errors).toEqual([]);
  });
});

test.describe('TULIP Team Allocation controls', () => {
  test('filters expose All / Gaining / Losing / No change and select exactly those rows', async ({ page }) => {
    const errors = await open(page);
    const expected = await page.evaluate(() => {
      const teams = [...new Set(DATA.leagues.NBA.map((player) => player.team))].sort();
      for (const team of teams) {
        const roster = DATA.leagues.NBA.filter((player) => player.team === team
          && player.tulipBeta && !player.tulipBeta.abstain);
        const counts = {
          all: roster.length,
          gaining: roster.filter((player) => player.tulipBeta.tulip > 0).length,
          losing: roster.filter((player) => player.tulipBeta.tulip < 0).length,
          nochange: roster.filter((player) => player.tulipBeta.tulip === 0).length,
        };
        if (counts.gaining && counts.losing && counts.nochange) return { team, counts };
      }
      return null;
    });
    expect(expected).not.toBeNull();
    await page.evaluate((team) => openTeamAllocation(team), expected.team);

    const controls = page.locator('[aria-label="Filter allocation table"]');
    await expect(controls).toBeVisible();
    await expect(controls.locator('[data-ta-filter]')).toHaveCount(4);
    await expect(controls).toContainText('All');
    await expect(controls).toContainText('Gaining');
    await expect(controls).toContainText('Losing');
    await expect(controls).toContainText('No change');

    for (const filter of ['all', 'gaining', 'losing', 'nochange']) {
      const button = controls.locator(`[data-ta-filter="${filter}"]`);
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      const rows = page.locator('[data-ta-roster-body] tr');
      await expect(rows).toHaveCount(expected.counts[filter]);
      if (filter !== 'all') {
        const directions = await rows.evaluateAll((items) => items.map((row) => row.dataset.taDirection));
        expect(new Set(directions)).toEqual(new Set([filter]));
      }
    }
    expect(errors).toEqual([]);
  });

  test('sort control defaults to descending TULIP and sorts every requested field', async ({ page }) => {
    const errors = await open(page);
    const team = await page.evaluate(() => [...new Set(DATA.leagues.NBA
      .filter((player) => player.tulipBeta && !player.tulipBeta.abstain)
      .map((player) => player.team))].sort()[0]);
    await page.evaluate((selectedTeam) => openTeamAllocation(selectedTeam), team);

    const select = page.locator('select[data-ta-sort][aria-label="Sort allocation table"]');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('tulip');
    expect(await select.locator('option').evaluateAll((options) => options.map((option) => option.value)))
      .toEqual(['tulip', 'current', 'recommended', 'support']);

    const ids = () => page.locator('[data-ta-roster-body] tr [data-player]')
      .evaluateAll((buttons) => buttons.map((button) => String(button.dataset.player)));
    const valuesFor = (playerIds, field) => page.evaluate(({ playerIds: requested, field: key }) => {
      const byId = new Map(DATA.leagues.NBA.map((player) => [String(player.playerId), player]));
      const supportRank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
      return requested.map((id) => {
        const c = byId.get(id).tulipBeta;
        if (key === 'support') return supportRank[c.confidence] || 0;
        if (key === 'current') return c.currentMpg;
        if (key === 'recommended') return c.recommendedMpg;
        return c.tulip;
      });
    }, { playerIds, field });

    for (const field of ['tulip', 'current', 'recommended', 'support']) {
      await select.selectOption(field);
      const values = await valuesFor(await ids(), field);
      expect(values.length).toBeGreaterThan(4);
      for (let i = 1; i < values.length; i++) {
        expect(values[i], `${field} is not descending at row ${i + 1}`).toBeLessThanOrEqual(values[i - 1]);
      }
    }
    expect(errors).toEqual([]);
  });
});
