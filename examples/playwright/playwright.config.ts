import { defineConfig } from '@playwright/test';

import cige from './cige.config.ts';

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.cige.spec.ts',
  // The cases share one shop's in-memory state, and each resets it first.
  workers: 1,
  timeout: 15_000,
  expect: { timeout: 2_000 },
  use: { baseURL: 'http://127.0.0.1:4173', actionTimeout: 2_000, trace: 'retain-on-failure' },
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:4173/health', reuseExistingServer: false },
  // The CIGE reporter writes .e2e/cige/<id>.run-summary.json for each case.
  reporter: [['list'], ['e2e-cige/playwright/reporter', cige]],
});
