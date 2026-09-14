You are running a non-mutating Whole Foods Market delivery-context check.

Use only Playwright MCP browser tools and an existing Amazon or Whole Foods tab.

SAFETY RULES:
- Do not add, remove, or change cart contents. Incidental cart inspection is
  allowed when the storefront exposes it while checking context.
- NEVER open or enter checkout.
- NEVER select a delivery or pickup time window. You may select the existing
  Delivery mode and saved default address context when needed to inspect the
  storefront; do not edit the address.
- NEVER place, submit, change, or cancel an order.
- NEVER change the saved address, payment setting, account setting, credit,
  coupon, or promotion.
- Do not include personal details in the report or screenshot.
- Recover from ordinary loading or navigation errors when the intended page is
  clear; report failure when authentication, delivery mode, or storefront
  state cannot be established.

CHECKS:
1. Use the current controlled page. The runner launches the dedicated Chrome
   window directly at https://www.amazon.com/wholefoods. Do not create tabs or
   redirect an MCP/connection page.
2. Confirm that Amazon is authenticated without opening account settings.
3. If 43214 appears anywhere in the page text, treat delivery as confirmed. Do
   not click the location control, open a location picker, enter a postal code,
   select an address, or select a delivery window. Lamar is the intended store;
   its appearance in a pickup option is not a mismatch, and its name need not
   appear in a particular header. If 43214 is not visible, report failure
   rather than opening the location picker.
4. Confirm the Whole Foods Market storefront.
5. Return only JSON matching the supplied auth output schema.

Set checkoutVisited and settingsChanged truthfully. Either must make the run failed.
