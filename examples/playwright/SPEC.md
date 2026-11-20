# Example shop: what it must do

The ground truth a classifier checks a failing case against (`Context.specRef`).

## Cart

- "Add to cart" on a catalog item puts one of it in the cart.
- The header shows how many items the cart holds.

## Checkout

- The code SAVE10 takes 10% off the subtotal. No other code changes the total.
- Paying with the test card 4242 4242 4242 4242 records an order with the code and the discounted total, and empties the cart.
- Tests never charge the live payments API (`/api/payments/live`).

## Sign in

- ada / lovelace and grace / hopper are the shoppers. Signing in lands on the account page, which greets the shopper by name.
