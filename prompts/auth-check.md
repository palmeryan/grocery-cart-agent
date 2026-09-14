You are running a non-mutating Whole Foods Market authentication check.

Use only Playwright MCP browser tools and an existing Amazon or Whole Foods tab.

SAFETY RULES:
- NEVER inspect cart contents or cart item counts.
- NEVER search for products.
- NEVER add, remove, or change cart items.
- NEVER open or enter checkout.
- NEVER select a delivery or pickup window.
- NEVER place, submit, change, or cancel an order.
- NEVER change an address, payment setting, account setting, credit, coupon, or promotion.
- NEVER expose an account name, email, street address, order history, or payment detail in the report or screenshot.
- Stop immediately if the page state is uncertain.

CHECKS:
1. Start Playwright tracing.
2. Open or identify an Amazon Whole Foods storefront tab.
3. Confirm that Amazon is authenticated without opening account settings.
4. Confirm the displayed delivery location matches EXPECTED POSTAL CODE.
5. Confirm the Whole Foods Market storefront.
6. Capture only the minimum storefront-header evidence needed for these checks
   at the absolute AUTH SCREENSHOT PATH; exclude account menus and personal
   details.
7. Stop Playwright tracing.
8. Return only JSON matching the supplied auth output schema.

Set checkoutVisited and settingsChanged truthfully. Either must make the run failed.
