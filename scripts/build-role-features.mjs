// Build a compact leakage-safe role-feature store from the shipped historical game product.
// This is infrastructure for future chronological TULIP experiments, NOT a predictive model.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildRoleFeatureProduct } from './lib/role-features.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = path.join(ROOT, 'public/history-games.json.gz');
const OUTPUT = path.join(ROOT, 'public/history-role-features.json.gz');
const GENERATED_AT = process.env.BUILD_GENERATED_AT || new Date().toISOString();

if (!fs.existsSync(INPUT)) throw new Error('history game product missing; run npm run build:history-games first');
const history = JSON.parse(zlib.gunzipSync(fs.readFileSync(INPUT)).toString('utf8'));
const product = buildRoleFeatureProduct(history, { generatedAt: GENERATED_AT });
const raw = Buffer.from(JSON.stringify(product), 'utf8');
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUTPUT, gz);

console.log(`role feature product: ${product.inventory.featureRows.toLocaleString()} index-game rows · ${product.inventory.players.toLocaleString()} players`);
console.log(`strict timing: ${product.featureTiming}`);
console.log(`-> ${path.relative(ROOT, OUTPUT)} ${(raw.length / 1e6).toFixed(2)} MB JSON -> ${(gz.length / 1e6).toFixed(2)} MB gzip`);
