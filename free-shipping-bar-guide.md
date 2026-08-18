# Free Shipping Progress Bar — Build Guide

A cart-total-driven widget that tells shoppers "You need X more for free
shipping," with a filling progress bar, and switches to a confirmation
message once they qualify. This guide generalizes the pattern from a working
Shopify/Liquid implementation so it can be rebuilt on any platform.

---

## 1. The concept in one sentence

Read the current cart total, compare it to a fixed threshold, and render
**three derived values**: remaining amount, percent-to-goal (capped at 100),
and a boolean "qualified" flag — then let markup/CSS do the rest.

Everything else in this guide is detail around that one calculation.

---

## 2. The math (platform-agnostic)

```
threshold          = 350.00  (in the store's currency, or its smallest unit — pick one and stay consistent)
current             = cart.total_price
remaining           = max(threshold - current, 0)
percent             = min(round(current / threshold * 100), 100)
qualified           = remaining <= 0
```

**Currency-unit trap:** Shopify's `cart.total_price` (and most platforms'
cart totals) are in the currency's **smallest unit** — cents/bani, not
decimal — e.g. 350.00 RON is `35000`, not `350`. Set your threshold constant
in the *same* unit as whatever total you're comparing it against, or the bar
will fill 100x too fast or too slow. This is the single most common bug when
porting this pattern to a new codebase — always check what unit the cart
total is actually in before hardcoding a threshold.

---

## 3. Get the live cart total — prefer reading over listening

The best version of this widget does **not** maintain its own state with
custom JS. Instead, it re-renders as a byproduct of whatever the platform
already does when the cart changes:

- **Shopify (Liquid + Horizon-style themes):** `{{ cart.total_price }}` is
  available directly in Liquid. If this snippet is rendered inside (or
  alongside) a component that already re-renders/morphs on cart mutation
  (Shopify's `cart-items-component`, or equivalent), the bar updates for
  free on every add/remove/quantity-change — zero widget-specific JS
  needed for reactivity.
- **Any platform with a cart API + client-side re-render (React/Vue/etc.):**
  Subscribe to whatever the framework's cart state/context already is
  (e.g. a `cart.total` selector, a `cart:updated` event). Don't poll and
  don't duplicate cart-total tracking in a separate variable — read the
  single source of truth every render.
- **Static/vanilla JS site with a cart stored in localStorage or a cookie:**
  Listen for your own `cart:updated` custom event (dispatched by whatever
  code adds/removes items) and recompute on that event, plus once on page
  load.

**Why this matters:** the moment you write custom state-tracking code for
"how much is in the cart right now," you've created a second source of
truth that can drift from the real cart (e.g. after a page navigation, a
multi-tab session, or a cart API failure). Always compute from the real
cart total at render/update time, never accumulate your own running total.

---

## 4. Markup structure

```html
<div class="free-shipping-bar" data-qualified="true|omitted">
  <div class="free-shipping-bar__row">
    <span class="free-shipping-bar__icon" aria-hidden="true">
      <!-- swap icon based on qualified state: truck vs checkmark -->
    </span>
    <p class="free-shipping-bar__message">
      <!-- "You need $12 more for free shipping" OR "You've unlocked free shipping!" -->
    </p>
  </div>
  <div
    class="free-shipping-bar__track"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow="{{ percent }}"
  >
    <div class="free-shipping-bar__fill" style="width: {{ percent }}%;"></div>
  </div>
</div>
```

Key structural decisions worth keeping:

- **`data-qualified` as a boolean attribute** (present/absent, not
  `"true"`/`"false"` string you'd have to parse) — lets CSS target the
  qualified state with a plain attribute selector and lets you branch
  message/icon logic on one flag everywhere.
- **`role="progressbar"` + `aria-valuemin/max/now`** — screen readers get
  the same "X% of the way there" information sighted users get from the
  visual fill. Don't skip this; it's three attributes for full
  accessibility compliance on what's otherwise a purely decorative bar.
- **Icon is `aria-hidden="true"`** — it's decorative/reinforcing, the
  message text already carries the actual information.
- **Hide the entire widget when the cart is empty.** Don't show "spend $50
  more" to someone who hasn't added anything yet — it reads as nagging,
  not helpful, outside the context of an active cart.

---

## 5. Two-state messaging, not just a full bar

Don't just let the bar hit 100% and stop — swap the **message and icon**
too, so qualifying feels like a small reward rather than the bar silently
maxing out:

| State | Icon | Message |
|---|---|---|
| In progress | truck/box outline | "You need **{{ remaining }}** more for free shipping" |
| Qualified | checkmark | "You've unlocked free shipping!" (often bolded/weight 600) |

Both message strings should go through your platform's translation/i18n
system if the site is multi-language — bake in a placeholder for the
remaining-amount value (e.g. `{{ 'free_shipping_remaining' | t: amount: remaining_money }}`
in Liquid, or an interpolation token in whatever i18n library you use).
Never hardcode the sentence in one language if the site serves more than
one — that's a common, easy-to-miss localization gap on exactly this kind
of small utility widget.

---

## 6. Styling that makes it feel considered, not stock

These are the specific visual choices that made the reference
implementation read as polished rather than a bare `<progress>` element:

- **Pick one accent color for this whole "helpful nudge" family of
  widgets** (free-shipping bar, trust badges, any other reassurance UI)
  and reuse it nowhere else on the site. A shopper learns "this color =
  a helpful signal" once, and every instance reinforces it. Don't let
  each widget invent its own color.
- **Gradient fill, not flat color**, on the progress bar itself
  (e.g. `linear-gradient(90deg, darker, accent 55%, lighter)`) — reads
  as more premium than a flat block.
- **A subtle moving "sheen" highlight** sweeping across the fill on a
  loop communicates "this is alive/progressing" without being loud.
  **Gate this behind `@media (prefers-reduced-motion: no-preference)`**
  — respect the OS-level motion-sensitivity setting; users who've opted
  out of animation shouldn't get a looping sheen forced on them.
- **Rounded, pill-shaped track** (`border-radius: 999px`) with a soft
  inset shadow reads as a "channel" the fill sits inside, rather than a
  flat bar.
- **A small decorative accent at the boundary** (a tiny diamond/dot
  centered on a divider line under the widget) is a cheap detail that
  makes the whole thing feel like part of a considered design system
  rather than a bolted-on plugin widget.
- **Keep the message text small and centered** (roughly 13–14px) — this
  is a supporting nudge, not a headline; it shouldn't compete with the
  actual page content around it.

---

## 7. Full reference implementation (Liquid / Shopify)

```liquid
{% liquid
  assign threshold = 35000  # 350.00 in currency subunit — MATCH YOUR CART TOTAL'S UNIT
  assign current = cart.total_price
  assign remaining = threshold | minus: current
  assign percent = current | times: 100.0 | divided_by: threshold | round
  if percent > 100
    assign percent = 100
  endif
  assign remaining_money = remaining | money
%}

{% unless cart.empty? %}
  <div class="free-shipping-bar" {% if remaining <= 0 %}data-qualified="true"{% endif %}>
    <div class="free-shipping-bar__row">
      <span class="free-shipping-bar__icon" aria-hidden="true">
        {% if remaining > 0 %}<!-- truck icon -->{% else %}<!-- checkmark icon -->{% endif %}
      </span>
      <p class="free-shipping-bar__message">
        {% if remaining > 0 %}
          {{ 'content.free_shipping_remaining_html' | t: amount: remaining_money }}
        {% else %}
          {{ 'content.free_shipping_qualified' | t }}
        {% endif %}
      </p>
    </div>
    <div class="free-shipping-bar__track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="{{ percent }}">
      <div class="free-shipping-bar__fill" style="width: {{ percent }}%;"></div>
    </div>
  </div>
{% endunless %}
```

Place it somewhere it re-renders with the cart — e.g. inside or right next
to your cart drawer/page template, so it participates in whatever section
re-render your theme already does on cart mutation. If it's placed
somewhere that does *not* naturally re-render (a static header, a
non-reactive include), you'll need to explicitly re-fetch/re-render it on
your cart-update event instead.

---

## 8. Vanilla JS / non-Shopify version

If the target site has no server-side templating tied to cart state, do
the same calculation client-side and re-run it whenever the cart changes:

```html
<div id="free-shipping-bar" class="free-shipping-bar" hidden>
  <div class="free-shipping-bar__row">
    <span class="free-shipping-bar__icon" aria-hidden="true"></span>
    <p class="free-shipping-bar__message"></p>
  </div>
  <div class="free-shipping-bar__track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
    <div class="free-shipping-bar__fill" style="width: 0%;"></div>
  </div>
</div>
```

```js
const THRESHOLD = 350.00; // in whatever unit your cart total function returns

function renderFreeShippingBar(cartTotal) {
  const el = document.getElementById('free-shipping-bar');
  if (cartTotal <= 0) { el.hidden = true; return; }
  el.hidden = false;

  const remaining = Math.max(THRESHOLD - cartTotal, 0);
  const percent = Math.min(Math.round((cartTotal / THRESHOLD) * 100), 100);
  const qualified = remaining <= 0;

  el.toggleAttribute('data-qualified', qualified);
  el.querySelector('.free-shipping-bar__message').textContent = qualified
    ? "You've unlocked free shipping!"
    : `You need ${formatMoney(remaining)} more for free shipping`;
  const track = el.querySelector('.free-shipping-bar__track');
  track.setAttribute('aria-valuenow', percent);
  el.querySelector('.free-shipping-bar__fill').style.width = percent + '%';
}

// Call this once on load, and again every time your cart actually changes —
// e.g. inside whatever add/remove/update-quantity handler already exists,
// or on a custom 'cart:updated' event if cart mutations happen in several
// places. Do not poll on a timer — trigger only on real cart changes.
document.addEventListener('cart:updated', (e) => renderFreeShippingBar(e.detail.total));
renderFreeShippingBar(getCurrentCartTotal());

function formatMoney(amount) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(amount);
}
```

Swap `formatMoney` for whatever currency the target store actually uses,
and swap `getCurrentCartTotal()` for however that site actually exposes
its cart state (a global store, an API call, a data attribute, etc.).

---

## 9. Checklist for porting this to a new site

- [ ] Confirm what unit the cart total is in (decimal vs. smallest-unit) and set the threshold to match
- [ ] Decide the actual free-shipping threshold with the client — don't guess a round number
- [ ] Wire the widget to real cart state (read-on-render, not a duplicated running total)
- [ ] Two message states + two icons (in-progress / qualified)
- [ ] Hide entirely on an empty cart
- [ ] `role="progressbar"` + `aria-value*` attributes
- [ ] Pick one accent color, reuse it for every "helpful nudge" widget on the site, nowhere else
- [ ] Gate any looping animation behind `prefers-reduced-motion: no-preference`
- [ ] Route both message strings through the site's i18n system if it's multi-language
- [ ] Verify it actually updates live after add/remove/quantity-change — don't just check the initial render
