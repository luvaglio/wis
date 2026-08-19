# Design System

The product has one visual language, not one for marketing and another
for the app. `design/tokens.json` and `design/tokens.css` are the
source of truth; this document explains how to apply them.

## Principle

Anything the user sees, the landing site, the onboarding conversation,
a WhatsApp message, a secure card popup, a payment confirmation, should
look like it came from the same hand. A user tapping a "confirm
payment" card should recognise it as the same product that showed them
the `/start` page, not a jarring switch to a generic checkout template.

## What every surface shares

- **Colour.** Paper background, ink text, hairline borders. No new
  palette per feature.
- **Type.** Instrument Sans (or the system fallback stack) for body
  text. The italic serif wordmark treatment, with its blinking caret,
  is reserved for the actual Wis.ai mark, it is not a generic
  decorative flourish to scatter around the UI.
- **Numerals.** Tabular monospace for any live or counted number
  (prices, quantities, countdowns), matching the `/start` page counter
  treatment.
- **Controls.** 10px radius, hairline border, white fill, the same
  focus ring. One button style: dark fill, light text, for the primary
  action; nothing else competes with it visually.
- **Motion.** Restrained. A staggered fade-in on entry, a sliding
  underline on links, a slight press-scale on buttons. No large
  transitions, no bouncing, no attention-seeking animation. Always
  respects `prefers-reduced-motion`.
- **No eyebrow titles.** Never put a small label above a heading (no
  "STEP 2", no "ONBOARDING", no kicker text above a page title). If
  context is needed, it belongs in the heading or the body copy
  itself, plainly.

## Secure user cards specifically

Cards (payment entry, credential entry, OAuth connector confirmation)
are a **constrained-width instance of the same design system**, not a
new component library:

- Same background, ink, hairline, radius, and button tokens.
- Short, calm copy: what is being asked for, and why, in one or two
  short lines. No marketing language on a security surface.
- One primary action, matching the primary button style everywhere
  else.
- URLs pointing to a card are short (`wis.ai/c/{shortcode}`), since
  they're read and tapped inside a chat thread on a phone. Never a long
  signed query string.
- Single-use and time-limited by default; the card itself should state
  its expiry plainly if relevant ("this link expires in 10 minutes").

## What not to do

- Do not introduce a second font family, even for "just this one
  screen."
- Do not invent a new corner radius, spacing unit, or colour for a new
  feature, extend `tokens.json`/`tokens.css` instead so it's available
  everywhere.
- Do not add eyebrow/kicker labels, badges-above-headings, or similar
  decorative category markers anywhere in the product.
