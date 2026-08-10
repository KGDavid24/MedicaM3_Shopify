# Building a Fully Custom Judge.me Reviews Widget

A field guide to replacing Judge.me's stock widgets with your own markup while
still getting the data Judge.me hides from the DOM — **owner replies, review
photos, and reviewer avatars**. Distilled from a working Shopify implementation
(`os-reviews.liquid`), but the data-layer parts are framework-agnostic and port
to any storefront.

> **Scope note.** Judge.me's API shapes, token exposure, and whether a given
> widget is server-rendered vs. XHR-loaded are **plan- and version-dependent**.
> Everything below was true for a Judge.me "carousel" (featured reviews) widget
> on the free/awareness tier at time of writing. Treat every field name as
> "verify on the target store first" — see §4 and §12.

---

## 0. Architecture at a glance

```
Judge.me widget.js  ─┐
(loads the carousel, ├─►  [1] Stock widgets  ──► hidden via CSS (parse-time)
 sets window.jdgm)   ┘        (carousel/all-reviews)      + JS (after scrape)

Your section:
  [2] API interceptor (runs immediately, before Judge.me's JS)
        patches XHR + fetch → captures any judge.me response
  [3] Token-based API fetch (in DOMContentLoaded)
        polls for window.jdgm.SHOP_TOKEN → GET judge.me/api/v1/reviews
      both [2] and [3] feed a lookup map: window._osJdgmEnhancements
  [4] DOM scrape of the rendered carousel items (base review data)
  [5] buildCard(): merge DOM (base) + map (avatar/photos/reply), prefer map
  [6] Presentation: marquee physics, collapsible, shuffle, blocklist, lightbox
```

**The core idea:** Judge.me's *carousel* renders server-side and strips replies
and photos out of the visible DOM. So you scrape the carousel for the base
review (author, body, stars, product, date) **and** pull the rich fields from
the API separately, then merge them per review.

---

## 1. Prerequisites — what must exist on the page

Your custom widget is a **parasite** on Judge.me's real widget. It cannot
invent data. You need, on the same page:

1. **Judge.me installed** and its `widget.js` loading (it sets `window.jdgm`).
2. **An actual Judge.me widget block placed** where you can scrape it — the
   *Featured Carousel* is ideal because it's server-rendered (data is in the
   HTML immediately). The *All Reviews* widget also works and additionally
   fires interceptable XHR.
3. Reviews that are **published**. Unpublished/pending reviews won't appear in
   the carousel or the public API.

If you remove the underlying Judge.me widget, your custom one goes blank. Hide
it with CSS (§7) — don't delete it.

---

## 2. Two data sources, and why you need both

| Source | Gives you | Misses | Reliability |
|---|---|---|---|
| **Carousel DOM scrape** | author, body, star count, product, date | replies, photos (stripped), real avatar URL | Always present (SSR) |
| **Judge.me API** (`/api/v1/reviews`) | everything incl. `reply_content`, `pictures_urls`, `reviewer.avatar_url` | nothing, but async + token-gated | Needs token + network |

Neither alone is enough:
- DOM-only → no replies, no photos.
- API-only → you'd have to fully render *and* handle pagination/ordering, and
  the token isn't guaranteed to resolve.

So: **DOM is the source of truth for which reviews to show and their base text;
the API is an enhancement layer keyed back onto those reviews.**

---

## 3. Getting review data from the Judge.me API

### 3a. The public token

Judge.me's own widget authenticates to its API with a **public, read-only shop
token** it exposes on the page. Look for it, in priority order:

```js
window.jdgm.SHOP_TOKEN            // most common
window.jdgm.shop_token
window.jdgm_config.token
window.jdgm_config.api_token
// last resort: scan inline <script> text for  SHOP_TOKEN: 'xxxxxxxx'
```

It is **read-only and already public** (it ships in page source), so using it
the same way the widget does is not a credential leak. Do **not** hardcode it —
it differs per store; resolve it at runtime.

### 3b. The endpoint

```
GET https://judge.me/api/v1/reviews
      ?api_token=<SHOP_TOKEN>
      &shop_domain=<myshop.myshopify.com>
      &per_page=100
      &page=1
    Accept: application/json
```

`shop_domain` = `Shopify.shop` if available, else `location.hostname`.
Response shape: `{ reviews: [ {...}, ... ] }` (sometimes `{ data: { reviews }}`
— handle both). Paginate if you have >100 reviews.

### 3c. Poll for the token (it isn't there at DOMContentLoaded)

Judge.me's JS and yours both run around `DOMContentLoaded`; order isn't
guaranteed. Poll briefly:

```js
const token = await new Promise(resolve => {
  let tries = 0;
  (function check() {
    const t = (window.jdgm && (window.jdgm.SHOP_TOKEN || window.jdgm.shop_token))
           || (window.jdgm_config && (window.jdgm_config.token || window.jdgm_config.api_token))
           || (() => {                              // scan inline scripts
                for (const s of document.querySelectorAll('script:not([src])')) {
                  const m = s.textContent.match(/SHOP_TOKEN\s*[:=]\s*['"]([^'"]{8,})['"]/);
                  if (m) return m[1];
                }
                return null;
              })();
    if (t || ++tries >= 30) resolve(t || null);     // ~3s max (30 × 100ms)
    else setTimeout(check, 100);
  })();
});
```

### 3d. The XHR + fetch interceptor (belt-and-braces)

Some Judge.me widgets (the All-Reviews widget, pagination, "load more") fetch
their data via XHR/fetch. Patch both **immediately** — at the top of your
script, *outside* `DOMContentLoaded` — so the patch is installed before
Judge.me's code runs and makes its calls. Any response from a judge.me URL is
parsed into the same lookup map.

```js
(function () {
  window._osJdgmEnhancements = {};                 // the lookup map

  function parseJdgmResponse(raw) {
    try {
      const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const reviews = d.reviews || (d.data && d.data.reviews) || (Array.isArray(d) ? d : []);
      reviews.forEach(storeReview);                 // storeReview: see §4
    } catch (_) {}
  }

  // XHR
  const _open = XMLHttpRequest.prototype.open, _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this._u = String(url || ''); return _open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (/judge\.?me|judgeme/i.test(this._u)) {
      const x = this;
      x.addEventListener('load', () => parseJdgmResponse(x.responseText));
    }
    return _send.apply(this, arguments);
  };

  // fetch
  if (window.fetch) {
    const _fetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || (input instanceof URL ? input.href : '');
      const p = _fetch.apply(this, arguments);
      if (/judge\.?me|judgeme/i.test(url)) {
        p.then(r => r.clone().json().then(parseJdgmResponse).catch(()=>{})).catch(()=>{});
      }
      return p;
    };
  }
})();
```

> **Why intercept AND fetch directly?** The carousel is SSR (nothing to
> intercept), so the direct fetch (§3b) covers it; other widgets are XHR, so the
> interceptor covers them. Together they cover every Judge.me plan/widget combo
> without you having to know which one is on the page.

---

## 4. The field-name quirks — the part that wastes hours

The single most important section. Judge.me's review objects vary by API
version; normalize defensively. This is `storeReview()`:

```js
function storeReview(r) {
  if (!r || typeof r !== 'object') return;
  const map = window._osJdgmEnhancements;

  // (a) REPLY lives in reply_content, and it is HTML — strip tags.
  const stripHtml = s => s ? String(s).replace(/<[^>]*>/g, '').trim() : '';
  let reply = stripHtml(r.reply_content)
           || r.reply || r.merchant_reply || r.reply_body || r.shop_reply
           || stripHtml(r.review_reply && (r.review_reply.body || r.review_reply.content))
           || (r.replies && r.replies[0] && (r.replies[0].body || r.replies[0].content))
           || '';
  if (reply && typeof reply === 'object') reply = '';

  // (b) PHOTOS live in pictures_urls: [{ original, small }]
  //     Keep {thumb, full} so the grid shows small and the lightbox shows original.
  const picList = r.pictures_urls || r.pictures || r.images || r.media || [];
  const photos = picList.map(p => {
    const thumb = p.small    || (p.urls && p.urls.small)    || p.url || p.src || '';
    const full  = p.original || (p.urls && p.urls.original) || thumb || '';
    const best  = thumb || full;
    return best ? { thumb: best, full: full || best } : null;
  }).filter(Boolean).slice(0, 4);

  // (c) AVATAR
  const avatarSrc = (r.reviewer && r.reviewer.avatar_url) || r.reviewer_avatar_url || null;

  const payload = { avatarSrc, photos, reply };

  // (d) THE KEY TRAP — see below. Store under BOTH id and uuid AND a fingerprint.
  if (r.id)   map['id:' + r.id]   = payload;
  if (r.uuid) map['id:' + r.uuid] = payload;
  const name = (r.reviewer && r.reviewer.name) || r.reviewer_name || r.author_name || '';
  const body = (r.body || r.content || r.message || '').trim().substring(0, 80);
  if (name && body) map[name + '||' + body] = payload;
}
```

### 4d. ⚠️ The UUID-vs-numeric-ID trap (read this twice)

- The **rendered carousel item** exposes `data-review-id` as a **UUID string**.
- The **API** returns each review's `id` as a **numeric** value (with `uuid` as
  a separate field, if present at all).

So the obvious merge — "match carousel `data-review-id` to API `id`" —
**silently never matches**, and you get base reviews with no photos/replies and
no error. Two defenses, both required:

1. In `storeReview`, index the payload under **`id`, `uuid`, AND an
   `author + '||' + first-80-chars-of-body` fingerprint**.
2. In `buildCard`, try the DOM id first, then fall back to the fingerprint:

```js
const domId  = item.dataset.reviewId;
const enhMap = window._osJdgmEnhancements || {};
const enh    = (domId && enhMap['id:' + domId])
            || enhMap[author + '||' + bodyText.substring(0, 80)]
            || {};
```

The **fingerprint is what actually carries the match** in practice, because the
IDs are in different namespaces. It also makes the whole thing robust to
Judge.me not setting `data-review-id` at all.

---

## 5. Scraping the carousel DOM (base data + fallback)

Judge.me class names drift between widget versions, so query **unions** of
selectors. These worked for the carousel + all-reviews widgets:

```js
// The review items themselves:
'.jdgm-carousel-item, .jdgm-carousel__item, .jdgm-rev, [class*="jdgm-carousel-item"]'

// Inside each item:
author  : '.jdgm-reviewer-name, .jdgm-rev__author'
body    : '.jdgm-text, .jdgm-rev__body-text'
product : '.jdgm-product-name, .jdgm-rev__product-title'
date    : '.jdgm-rev__timestamp, .jdgm-reviewer-date, [class*="timestamp"]'
stars   : '.jdgm-star.jdgm--on'          // count these; rating = min(count || 5, 5)
avatar  : 'img.jdgm-rev__author-pic, img[class*="author-pic"], img[class*="reviewer-pic"], .jdgm-rev__header img'
reply   : '.jdgm-rev__reply, [class*="rev__reply"]'  →  '.jdgm-rev__reply-body, [class*="reply-body"], p'
photos  : '.jdgm-rev__pic-img, img[class*="pic-img"], .jdgm-rev__pics img, .jdgm-rev__pic img'
```

Notes:
- Reviewer/review images often lazy-load: read `img.dataset.src` **before**
  `img.getAttribute('src')` (the `src` may still be a placeholder).
- Filter junk URLs: skip anything matching `/no[-_]?photo|default|blank|placeholder/i`.
- Stars: Judge.me marks filled stars with the extra class `jdgm--on`.
- Treat these DOM reads as **fallbacks** — prefer the API payload when present
  (the API avatar/photos are full-res; the DOM ones may be lazy placeholders).

---

## 6. Merging API + DOM per card

```js
const photoSrc     = enh.avatarSrc || domPhotoSrc;                       // avatar
const reviewPhotos = (enh.photos && enh.photos.length) ? enh.photos      // photos
                                                       : domReviewPhotos;
const replyText    = enh.reply || domReplyText;                          // reply
```

Rule of thumb: **API wins, DOM fills gaps.**

---

## 7. Hiding the stock Judge.me widgets

Two layers, because you must hide them *before paint* but only remove the
scrape source *after* scraping:

**CSS (in `<style>`, applies at parse time — nothing ever flashes):**
```css
#judgeme_featured_carousel,
.jdgm-carousel-wrapper,
.jdgm-all-reviews-widget,
.jdgm-widget-wrapper,
[class*="jdgm"][class*="carousel"],
[class*="jdgm"][class*="all-reviews"] { display: none !important; }
```

**JS (after `buildMarquee`, once you've scraped):** walk up from a
`.jdgm-carousel-item` to the outermost `jdgm/judgeme` ancestor and
`display:none` it, then also blank known wrappers. (If you hide the carousel
purely in CSS *before* scraping, some Judge.me builds skip populating a hidden
widget — so keep the carousel scrape-able and hide it in JS after. The
all-reviews widget can be CSS-hidden up front.)

---

## 8. Building cards — security

**All third-party text goes through `textContent`, never `innerHTML`.** Judge.me
review bodies and replies are user-submitted; injecting them as HTML is stored
XSS waiting to happen. The only `innerHTML` used is for **your own** static SVG
icons. Build every card with `document.createElement` + `.textContent`:

```js
const h4 = document.createElement('h4');
h4.textContent = author;              // ✅ safe
// never: el.innerHTML = review.body  // ❌
```

Images: set `img.src` from scraped/API URLs and attach `img.onerror = () =>
img.remove()` so a dead URL degrades gracefully (avatar falls back to initials).

---

## 9. Presentation features (optional, but this is what makes it feel custom)

These are storefront-agnostic; keep or drop per design.

### 9a. Dedup
The same review can appear in two widgets (different `outerHTML`), so dedup by
**review id if present, else `author + '||' + first-80-chars-of-body`** — the
same fingerprint used for the API merge. A plain `outerHTML` set does **not**
catch cross-widget duplicates.

### 9b. Moderation blocklist
A merchant-editable, comma/newline-separated list of name fragments,
**case-insensitive partial match** ("Yevgen" hides "Yevgen Melnykov"). Purpose:
dummy/test reviews that can't be deleted in Judge.me. Filter during dedup.

### 9c. Shuffle with boundary swap
Fisher–Yates shuffle per rendered group. When cloning the review set into
multiple marquee lanes, if a group's **first** card equals the previous group's
**last** card, swap it forward — so the same face never appears twice across a
seam.

### 9d. Collapsible bodies with equal card heights
- Collapse to a fixed `max-height` (~3 lines) with a fade-out gradient
  `::after`; `.is-expanded` raises `max-height` with a transition.
- After render, `requestAnimationFrame` → if `scrollHeight <= clientHeight` the
  text already fits: add a `no-clip` class (kill the gradient) and set the
  expand button to **`visibility:hidden`, not `display:none`** — so short cards
  keep the same height as cards that do have a button. Equal heights are what
  make the row look intentional.

### 9e. Lightbox for review photos
Single reusable `#os-lightbox` appended to `<body>` once. Store `{thumb, full}`
so thumbnails are small but the lightbox opens the `original`. Supports
prev/next, a counter, backdrop-click / Esc to close, and Arrow-key nav. Lock
`body { overflow:hidden }` while open.

### 9f. Marquee physics (infinite loop + drag + touch)
- Build **≥3 identical lanes** (this impl uses 4) of the shuffled set.
- Start `scrollLeft = oneLaneWidth`; each frame add `speed`; when
  `scrollLeft <= 0` add a lane width, when `>= 2 × laneWidth` subtract one —
  seamless loop.
- Pause on hover/touch; drag to scroll (`mousedown/move/up`, multiply delta
  ~1.5); touch handlers `{ passive:true }`.
- Respect `prefers-reduced-motion` → set auto-speed to 0.
- `expandBtn` click must `e.stopPropagation()` so expanding doesn't start a drag.

---

## 10. Settings / schema (Shopify example)

Expose the knobs a merchant actually touches:

```json
{ "type": "range",    "id": "scroll_speed",  "min": 0, "max": 5, "step": 0.5, "default": 1 },
{ "type": "text",     "id": "badge" },
{ "type": "html",     "id": "title_html" },
{ "type": "text",     "id": "subtitle" },
{ "type": "text",     "id": "blocklist", "info": "Comma-separated name fragments to hide (partial match). For dummy reviews you can't delete in Judge.me." }
```

Pass server-side text (locale strings, blocklist) into JS via a hidden
`data-*` element rather than string-interpolating into the script — cleaner and
escaping-safe:

```html
<div id="os-reviews-i18n" hidden
  data-verified="{{ 'reviews.verified' | t | escape }}"
  data-read-more="{{ 'reviews.read_more' | t | escape }}"
  data-reply-label="{{ 'reviews.reply_label' | t | escape }}"
  data-blocklist="{{ section.settings.blocklist | escape }}"></div>
```

---

## 11. Timing & race conditions (the fragile part)

Order matters more than anything else here:

1. **Interceptor installs synchronously** at script top (before Judge.me JS).
2. On `DOMContentLoaded`: kick off the **token poll + API fetch** (async), and
   start a **`MutationObserver`** watching for carousel items to appear.
3. When items appear, `observer.disconnect()` and build — but first
   **`Promise.race([apiFetch, timeout(3.5s)])`** so you wait for enhancement
   data *but never block the marquee forever* if the token/API never resolves.
4. Belt-and-braces: a `setTimeout(tryBuild, 3000)` in case the observer misses,
   and `setTimeout(() => observer.disconnect(), 15000)` to stop watching.

The `Promise.race` is the key resilience move: **the marquee always renders**,
with enhancements if they arrive in time and without them if they don't.

---

## 12. Porting checklist for a new site

1. **Confirm the token exists**: in console, check `window.jdgm.SHOP_TOKEN`
   (and the fallbacks). No token → you're DOM-only (no photos/replies).
2. **Confirm the API shape**: hit
   `https://judge.me/api/v1/reviews?api_token=…&shop_domain=…&per_page=5` and
   **eyeball the JSON**. Verify these field names on *this* store:
   - reply → `reply_content`? HTML or plain?
   - photos → `pictures_urls`? `{original, small}` or other keys?
   - avatar → `reviewer.avatar_url`?
   - `id` numeric vs `uuid` — **check what the carousel's `data-review-id` is**
     and whether it matches API `id`. If not, the fingerprint fallback carries it.
3. **Confirm the carousel selectors**: inspect a rendered `.jdgm-carousel-item`
   and update the selector unions in §5 if the class names differ.
4. Place a Judge.me carousel (or all-reviews) widget on the page; hide via §7.
5. Drop in the interceptor (§3d) + token fetch (§3c) + `storeReview` (§4) +
   scrape/merge/build (§5–8). Wire timing per §11.
6. Restyle the card markup to the new brand. The data layer is unchanged.

---

## 13. Known limitations

- **Plan/version coupling.** Field names (`reply_content`, `pictures_urls`) and
  token exposure can change with Judge.me plan or an app update. §12 step 2 is
  not optional on a new store.
- **Only published reviews.** Pending/unpublished reviews aren't in the carousel
  or public API.
- **Needs the stock widget present.** It's a scraper; kill the source and it
  goes blank.
- **Enhancement is best-effort.** If the token never resolves, you still get a
  correct marquee — just without avatars/photos/replies for that load.
- **No write access.** This read-only token can't submit reviews or replies;
  it's display-only. Review submission still goes through Judge.me's own form.
```

