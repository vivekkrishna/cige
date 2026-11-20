// The Execution of login.cige.json as Playwright code: one binding per step.
// Rewrite a binding when the flow changes; that is what Execution is for.
// What a pass means stays in the case and cige.config.ts, where `cige diff` guards it:
// the Intent, the Guardrails, and the evidence. Never weaken a verify to make it pass.
// Intent: A returning shopper can sign in as {user}
//
// Guardrails: every binding must keep to them; no agent reads them here.
// - [g1] Never create a new account

import { expect } from '@playwright/test';
import { cigeTest } from 'e2e-cige/playwright';

import config from '../cige.config.ts';

// One test per variant (ada, grace): params carries the variant's values.
cigeTest(config, 'login', {
  // Step: Sign in as {user} with the password {password}
  // Values: params.user, params.password
  e1: async ({ page, params }) => {
    await page.getByLabel('Username').fill(String(params.user));
    await page.getByLabel('Password').fill(String(params.password));
    await page.getByRole('button', { name: 'Sign in' }).click();
  },
  // Verify: The account page greets {user}
  // Check it with expect(): a failed expect here is read as a product defect.
  e2: async ({ page, params }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Welcome back, ${String(params.user)}`);
  },
});
