import { CigeError, defineCige } from 'e2e-cige/core';
import { playwrightRunner, type CigePlaywrightFixtures } from 'e2e-cige/playwright';

/**
 * The hooks are the proof a pass needs, in code: `cige diff` blocks any change
 * to this file for a human's approval, so a repair can't weaken them.
 */
export default defineCige<CigePlaywrightFixtures>({
  cases: 'tests/*.cige.json',
  root: new URL('.', import.meta.url),
  build: process.env.GITHUB_SHA,
  // Every case resets the shop itself (the freshShop precondition), so a replay needs no reset of its own.
  environments: { local: { reset: () => undefined } },
  hooks: {
    // A precondition fails only by throwing: the shop not answering is the environment, not the case.
    freshShop: async ({ request }) => {
      const reset = await request.post('/api/reset').catch((cause: unknown) => {
        throw new CigeError('ENVIRONMENT_UNAVAILABLE', `the shop is not answering: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
      if (!reset.ok()) throw new CigeError('ENVIRONMENT_UNAVAILABLE', `POST /api/reset answered ${reset.status()}`);
    },
    // Evidence holds only when it returns true.
    cartHasOneBook: async ({ request }) => {
      const cart = (await (await request.get('/api/cart')).json()) as { items: string[] };
      return cart.items.length === 1 && cart.items[0] === 'BOOK-1';
    },
    orderDiscounted: async ({ request }) => {
      const response = await request.get('/api/orders/last');
      if (response.status() === 404) return false;
      const order = (await response.json()) as { code: string; subtotal: number; total: number };
      return order.code === 'SAVE10' && Math.abs(order.total - order.subtotal * 0.9) < 0.005;
    },
    // page.request shares the page's cookies: the session the shopper signed in with.
    signedInAsUser: async ({ page }, testCase) => {
      const response = await page.request.get('/api/session');
      return response.ok() && ((await response.json()) as { user: string }).user === testCase.params?.user;
    },
  },
  runners: { playwright: playwrightRunner() },
  runner: 'playwright',
});
