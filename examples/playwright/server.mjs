// A tiny shop for the example: a catalog, a cart, a checkout with discount codes, sign-in, and orders.
// State lives in memory; POST /api/reset empties it. Three switches break it on purpose:
//   SHOP_RENAME=1         the "Add to cart" button reads "Add to bag" (a changed flow)
//   SHOP_BUG=discount     the total ignores the discount code (a product defect)
//   SHOP_LIVE_PAYMENTS=1  checkout charges the live payments API (a guardrail violation)
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4173);
const PRODUCTS = [
  { sku: 'BOOK-1', name: 'Field Guide', price: 50 },
  { sku: 'MUG-1', name: 'Enamel Mug', price: 12 },
];
const USERS = { ada: 'lovelace', grace: 'hopper' };

let state;
function emptyState() {
  state = { cart: [], orders: [], sessions: new Map() };
}
emptyState();

const money = (n) => `$${n.toFixed(2)}`;
const addLabel = () => (process.env.SHOP_RENAME === '1' ? 'Add to bag' : 'Add to cart');
const priced = (code) => {
  const subtotal = state.cart.reduce((sum, item) => sum + item.price, 0);
  const discounted = code === 'SAVE10' && process.env.SHOP_BUG !== 'discount';
  return { subtotal, total: discounted ? subtotal * 0.9 : subtotal };
};

function html(title, main) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<header><a href="/">Shop</a> · <a href="/cart">Cart (<span data-testid="cart-count">${state.cart.length}</span>)</a> · <a href="/login">Sign in</a></header>
<main>${main}</main></body></html>`;
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  if ((req.headers['content-type'] ?? '').includes('application/json')) return JSON.parse(text || '{}');
  return Object.fromEntries(new URLSearchParams(text));
}

function userOf(req) {
  const sid = /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  return sid === undefined ? undefined : state.sessions.get(sid);
}

const CHECKOUT_SCRIPT = (pay, code) => `
document.getElementById('pay').addEventListener('click', async () => {
  const card = document.querySelector('[name=card]').value;
  const status = document.getElementById('status');
  try {
    const response = await fetch(${JSON.stringify(pay)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card, code: ${JSON.stringify(code)} }) });
    const order = await response.json();
    status.textContent = response.ok ? 'Order ' + order.id + ' confirmed' : 'Payment declined';
  } catch {
    status.textContent = 'Payment failed';
  }
});`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, content, type = 'text/html', headers = {}) => {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(content);
  };
  const json = (status, value) => send(status, JSON.stringify(value), 'application/json');
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /health') return send(200, 'ok', 'text/plain');
  if (route === 'POST /api/reset') {
    emptyState();
    return json(200, { ok: true });
  }
  if (route === 'GET /') {
    const items = PRODUCTS.map(
      (p) => `<li><span>${p.name}</span> <span>${money(p.price)}</span>
<form method="post" action="/cart"><input type="hidden" name="sku" value="${p.sku}"><button aria-label="${addLabel()}: ${p.name}">${addLabel()}</button></form></li>`,
    ).join('');
    return send(200, html('Shop', `<h1>Catalog</h1><ul>${items}</ul>`));
  }
  if (route === 'POST /cart') {
    const { sku } = await readBody(req);
    const product = PRODUCTS.find((p) => p.sku === sku);
    if (product) state.cart.push(product);
    return send(303, '', 'text/plain', { location: '/' });
  }
  if (route === 'GET /api/cart') return json(200, { items: state.cart.map((item) => item.sku) });
  if (route === 'GET /cart') {
    const rows = state.cart.map((item) => `<li>${item.name} ${money(item.price)}</li>`).join('');
    return send(200, html('Cart', `<h1>Cart</h1><ul>${rows}</ul><a href="/checkout">Checkout</a>`));
  }
  if (route === 'GET /checkout') {
    const code = url.searchParams.get('code') ?? '';
    const { subtotal, total } = priced(code);
    const pay = process.env.SHOP_LIVE_PAYMENTS === '1' ? '/api/payments/live' : '/api/payments/test';
    return send(
      200,
      html(
        'Checkout',
        `<h1>Checkout</h1><p>Subtotal <span data-testid="subtotal">${money(subtotal)}</span></p>
<form method="get" action="/checkout"><label>Discount code <input name="code" value="${code}"></label><button>Apply</button></form>
<p>Total <strong data-testid="total">${money(total)}</strong></p>
<label>Card <input name="card" placeholder="Card number"></label>
<button id="pay">Pay</button><p role="status" id="status"></p>
<script>${CHECKOUT_SCRIPT(pay, code)}</script>`,
      ),
    );
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/payments/')) {
    const { card, code } = await readBody(req);
    if (url.pathname === '/api/payments/test' && card !== '4242 4242 4242 4242') return json(402, { error: 'declined' });
    const order = { id: state.orders.length + 1, items: state.cart.map((item) => item.sku), code, ...priced(code) };
    state.orders.push(order);
    state.cart = [];
    return json(200, order);
  }
  if (route === 'GET /api/orders/last') return state.orders.length === 0 ? json(404, { error: 'no order' }) : json(200, state.orders.at(-1));
  if (route === 'GET /login') {
    return send(
      200,
      html('Sign in', `<h1>Sign in</h1><form method="post" action="/login"><label>Username <input name="user"></label> <label>Password <input name="password" type="password"></label> <button>Sign in</button></form>`),
    );
  }
  if (route === 'POST /login') {
    const { user, password } = await readBody(req);
    if (USERS[user] !== password) return send(401, html('Sign in', '<h1>Sign in</h1><p role="alert">Wrong username or password</p>'));
    const sid = Math.random().toString(36).slice(2);
    state.sessions.set(sid, user);
    return send(303, '', 'text/plain', { location: '/account', 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
  }
  if (route === 'GET /account') {
    const user = userOf(req);
    return user === undefined ? send(303, '', 'text/plain', { location: '/login' }) : send(200, html('Account', `<h1>Welcome back, ${user}</h1>`));
  }
  if (route === 'GET /api/session') {
    const user = userOf(req);
    return user === undefined ? json(401, { error: 'signed out' }) : json(200, { user });
  }
  return send(404, html('Not found', '<h1>Not found</h1>'));
});

server.listen(PORT, '127.0.0.1', () => console.log(`shop on http://127.0.0.1:${PORT}`));
