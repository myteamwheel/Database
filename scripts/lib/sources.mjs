// Shared loaders + identity helpers for the 2025-26 build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

/** Read a stats.nba.com resultSets payload into an array of plain objects. */
export function loadOfficial(dir, file) {
  const p = path.join(DATA_DIR, dir, `${file}.json`);
  if (!fs.existsSync(p)) return [];
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const rs = Array.isArray(j.resultSets) ? j.resultSets[0] : j.resultSets;
  if (!rs || !rs.rowSet) return [];
  return rs.rowSet.map((r) => Object.fromEntries(rs.headers.map((h, i) => [h, r[i]])));
}

/** Index rows by PLAYER_ID (or PERSON_ID). */
export function byId(rows, key = 'PLAYER_ID') {
  return new Map(rows.map((r) => [r[key], r]));
}

/**
 * Name key used only for joining Basketball-Reference rows onto official rows.
 * Official NBA person IDs are the real identity key wherever both sides have one.
 */
export function nameKey(s) {
  return String(s || '')
    // Cyrillic lookalikes must be transliterated BEFORE decomposition: ё decomposes to
    // Cyrillic е + diaeresis, and stripping the diaeresis leaves U+0435, not a Latin e.
    // Basketball-Reference writes "Egor Dёmin" (Cyrillic), stats.nba.com "Egor Dëmin" (Latin).
    .replace(/[ёЁ]/g, 'e')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[еЕ]/g, 'e')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/-/g, ' ')               // "Adama-Alpha Bal" -> "adama alpha bal"
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Verified Basketball-Reference -> stats.nba.com name equivalences.
 * Each was confirmed by matching team + games played + minutes on both sides.
 */
export const NAME_ALIASES = new Map(Object.entries({
  // NBA
  'adama alpha bal': 'adama bal',
  'ron holland': 'ronald holland',
  'tre scott': 'trevon scott',
  // G League
  'christopher mantis': 'chris mantis',
  'dre davis': 'dandre davis',
  'david jones': 'david jones garcia',
  'eli cain': 'elijah cain',
  'eli pemberton': 'elijah pemberton',
  'esteban roacho': 'esteban ezequiel roacho amador',
  'gregory jackson': 'gg jackson',
  'fernandus brown': 'martez brown',
  'matthew cleveland': 'matt cleveland',
  'nathan mensah': 'nate mensah',
  'jeenathan williams': 'nate williams',
  'william baker': 'will baker',
  'eli john ndiaye': 'eli ndiaye',
}));

export function resolveName(s) {
  const k = nameKey(s);
  return NAME_ALIASES.get(k) || k;
}

export const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
export const safeDiv = (a, b) => (num(a) === null || !num(b) ? null : num(a) / num(b));
export const round = (v, d = 3) => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
