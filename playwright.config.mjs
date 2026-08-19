export default {
  testDir: './tests',
  // Playwright's default testMatch also catches *.test.mjs, which collected the Node-run suites
  // (bmatch, oracle, starter-merge, history). Those then executed under Playwright's argv: the
  // oracle test read process.argv[2] as its instance count, got NaN, compared ZERO edges and
  // still exited 0 — a safety-critical test passing vacuously. Browser specs are *.spec.mjs only;
  // the Node suites run via `npm run test:starter` / `npm run test:history`.
  testMatch: /.*\.spec\.mjs$/,
  timeout: 120000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { headless: true, viewport: { width: 1440, height: 900 } },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
};
