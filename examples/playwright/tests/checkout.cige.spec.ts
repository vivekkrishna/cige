// The Execution of checkout.cige.json as Playwright code: one binding per step.
// Rewrite a binding when the flow changes; that is what Execution is for.
// What a pass means stays in the case and cige.config.ts, where `cige diff` guards it:
// the Intent, the Guardrails, and the evidence. Never weaken a verify to make it pass.
// Intent: A shopper can check out with the SAVE10 code and get an order with 10% off
//
// Guardrails: every binding must keep to them; no agent reads them here.
// - [no-live-payments] Never charge the live payments API; pay only through the test payments API
//   Enforced: requests to POST **/api/payments/live* are blocked, and the step that sends one fails.
// - [test-card-only] Use only the test card 4242 4242 4242 4242

import { expect } from '@playwright/test';
import { cigeTest } from 'e2e-cige/playwright';

import config from '../cige.config.ts';

cigeTest(config, 'checkout', {
  // Step: Add the Field Guide to the cart
  e1: async ({ page }) => {
    await page.getByRole('button', { name: 'Add to cart: Field Guide' }).click();
    await expect(page.getByTestId('cart-count')).toHaveText('1');
  },
  // Step: Open checkout and apply the discount code SAVE10
  e2: async ({ page }) => {
    await page.goto('/checkout');
    await page.getByLabel('Discount code').fill('SAVE10');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByLabel('Discount code')).toHaveValue('SAVE10');
  },
  // Verify: The total shows $45.00
  // Check it with expect(): a failed expect here is read as a product defect.
  e3: async ({ page }) => {
    await expect(page.getByTestId('total')).toHaveText('$45.00');
  },
  // Step: Pay with the test card and wait for the order confirmation
  e4: async ({ page }) => {
    await page.getByLabel('Card').fill('4242 4242 4242 4242');
    await page.getByRole('button', { name: 'Pay' }).click();
    await expect(page.getByRole('status')).toHaveText(/Order \d+ confirmed/);
  },
});
