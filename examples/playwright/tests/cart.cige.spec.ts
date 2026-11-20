// The Execution of cart.cige.json as Playwright code: one binding per step.
// Rewrite a binding when the flow changes; that is what Execution is for.
// What a pass means stays in the case and cige.config.ts, where `cige diff` guards it:
// the Intent, the Guardrails, and the evidence. Never weaken a verify to make it pass.
// Intent: A shopper can add a book to the cart
//
// Guardrails: every binding must keep to them; no agent reads them here.
// - [g1] Never use a real payment card

import { expect } from '@playwright/test';
import { cigeTest } from 'e2e-cige/playwright';

import config from '../cige.config.ts';

cigeTest(config, 'cart', {
  // Step: Add the Field Guide to the cart
  e1: async ({ page }) => {
    await page.getByRole('button', { name: 'Add to cart: Field Guide' }).click();
  },
  // Verify: The cart count in the header shows 1
  // Check it with expect(): a failed expect here is read as a product defect.
  e2: async ({ page }) => {
    await expect(page.getByTestId('cart-count')).toHaveText('1');
  },
});
