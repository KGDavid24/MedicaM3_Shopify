# Scroll-reveal "floating card" sections

How the animated homepage cards work on skanzen.ro (the panels for Házaink / Múzeum / Programjaink / Rendezvényeink), and how to port the pattern to a plain (non-Shopify) site.

## What it actually is

Each "card" is a two-column section — an image on one side, a heading/text/CTA on the other — presented as a rounded, inset floating panel. The **image slides in from its own edge** (left card → image slides in from the left; right-facing card → from the right) and the **text panel slides in from the opposite edge**, both fading in from `opacity: 0`, the moment the section first scrolls into view. If two cards are stacked close together, the second one's reveal is barely staggered after the first so they don't look perfectly synchronized.

It is **not** a hover effect and **not** a continuous/looping animation — it fires once, the first time each card enters the viewport, then never again.

Three pieces make it work:
1. A custom element (`<reveal-on-scroll>`) that watches its own children with an `IntersectionObserver` and flips a data-attribute when they scroll into view.
2. CSS `@keyframes` that only start animating once that data-attribute is present.
3. Separate "card" styling (rounded corners, inset margin, tinted background panel) — cosmetic, independent of the animation itself.

## 1. The JavaScript (framework-agnostic, copy as-is)

This is a native Web Component — no build step, no dependencies. Save as `reveal-on-scroll.js` and load it as a `<script type="module">`.

```js
/**
 * <reveal-on-scroll> wraps a media + content pair and animates each side in
 * from its own edge the first time it scrolls into view.
 *
 * - Every target animates in the first time it crosses the intersection
 *   threshold, including one that's already on screen when observed (its
 *   reveal just plays immediately).
 * - Each element animates once, then stops being observed.
 * - Respects prefers-reduced-motion.
 */

const OBSERVER_OPTIONS = {
  // Fire as soon as the element starts entering the viewport (rather than
  // waiting for e.g. 15% of it to be visible) — with near-full-viewport-tall
  // cards, waiting for a percentage means scrolling well past the still-empty
  // element before its reveal kicks in.
  threshold: 0,
  rootMargin: '0px 0px 200px 0px',
};

const STAGGER_MS = 100;

class RevealOnScroll extends HTMLElement {
  #observer;

  connectedCallback() {
    if (this.dataset.animate === 'false') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const mediaRight = this.classList.contains('media-with-content--media-right');
    const media = this.querySelector('.media-block');
    const content = this.querySelector('.media-with-content__content');

    const targets = [];

    if (media instanceof HTMLElement) {
      media.dataset.revealDirection = mediaRight ? 'right' : 'left';
      targets.push(media);
    }

    if (content instanceof HTMLElement) {
      content.dataset.revealDirection = mediaRight ? 'left' : 'right';
      targets.push(content);
    }

    if (targets.length === 0) return;

    targets.forEach((el) => {
      el.setAttribute('data-reveal-armed', '');
    });

    this.#observer = new IntersectionObserver((entries) => {
      entries.forEach((entry, index) => {
        if (!entry.isIntersecting) return;

        const el = entry.target;

        window.setTimeout(() => {
          el.removeAttribute('data-reveal-armed');
          el.setAttribute('data-reveal-active', '');
        }, index * STAGGER_MS);

        this.#observer?.unobserve(el);
      });
    }, OBSERVER_OPTIONS);

    targets.forEach((el) => this.#observer?.observe(el));
  }

  disconnectedCallback() {
    this.#observer?.disconnect();
  }
}

if (!customElements.get('reveal-on-scroll')) {
  customElements.define('reveal-on-scroll', RevealOnScroll);
}
```

**How the direction logic works:** the component looks for exactly two children by class — `.media-block` (the image) and `.media-with-content__content` (the text side) — and assigns each a `data-reveal-direction` of `left` or `right` based on whether the card overall is flagged `media-with-content--media-right`. The image and text always come from *opposite* edges, so they visually converge toward the center.

If you're reusing this outside Shopify, the only site-specific bits are those two class names (`.media-block`, `.media-with-content__content`) and the `media-with-content--media-right` modifier — rename them to whatever your markup uses, everything else is generic.

## 2. The CSS

```css
/* Both halves start invisible until the observer arms + fires them */
.media-block[data-reveal-armed],
.media-with-content__content[data-reveal-armed] {
  opacity: 0;
}

[data-reveal-active] {
  animation-duration: 1.2s;
  animation-timing-function: ease-out;
  animation-fill-mode: both;
}

[data-reveal-active][data-reveal-direction='left'] {
  animation-name: reveal-left;
}

[data-reveal-active][data-reveal-direction='right'] {
  animation-name: reveal-right;
}

@keyframes reveal-left {
  from {
    opacity: 0;
    transform: translateX(-64px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes reveal-right {
  from {
    opacity: 0;
    transform: translateX(64px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* Belt-and-suspenders: even if JS/observer never fires for some reason,
   never leave content stuck at opacity:0 for reduced-motion users */
@media (prefers-reduced-motion: reduce) {
  .media-block[data-reveal-armed],
  .media-with-content__content[data-reveal-armed] {
    opacity: 1;
  }
}
```

The "floating card" look (rounded corners, inset from the page edge, tinted panel background) is a **separate, optional** layer on top of this — nothing to do with the animation:

```css
.card-section {
  width: calc(100% - 24px);
  margin-block: 12px;
  margin-inline: 16px;
  border-radius: 24px;
  overflow: hidden; /* clips the image to the rounded corners */
}

.card-section .content-panel {
  background-color: #f5f3f0; /* or color-mix() with an accent color, see original */
}
```

## 3. The HTML structure

```html
<script src="/reveal-on-scroll.js" type="module"></script>

<reveal-on-scroll class="card-section" data-animate="true">
  <div class="media-block">
    <img src="..." alt="..." />
  </div>
  <div class="media-with-content__content">
    <h3>Heading</h3>
    <p>Body copy.</p>
    <a href="..." class="button">Call to action</a>
  </div>
</reveal-on-scroll>

<!-- mirror the layout for the next card so image/text alternate sides -->
<reveal-on-scroll class="card-section media-with-content--media-right" data-animate="true">
  <div class="media-with-content__content">
    <h3>Heading</h3>
    <p>Body copy.</p>
  </div>
  <div class="media-block">
    <img src="..." alt="..." />
  </div>
</reveal-on-scroll>
```

Notes:
- `data-animate="false"` on the `<reveal-on-scroll>` element disables the animation entirely for that instance (falls back to always-visible) — useful as a per-section admin toggle, or just delete the attribute check if you don't need it.
- The actual DOM order of `.media-block` vs `.media-with-content__content` doesn't need to match the visual left/right order (that's handled by CSS grid `order`/`grid-template-areas` on the real site) — the component finds them by class regardless of DOM position.
- Each `<reveal-on-scroll>` element is independent — you can have any number of these cards on a page, each with its own observer instance, and each fires once on its own schedule as the user scrolls to it.

## Tuning knobs

| Value | What it does | Where |
|---|---|---|
| `STAGGER_MS` | Delay between the image and text half animating in (currently 100ms) | JS constant |
| `OBSERVER_OPTIONS.threshold` | How much of the element must be visible before it's considered "intersecting" (`0` = as soon as any pixel is visible) | JS constant |
| `OBSERVER_OPTIONS.rootMargin` | Expands/shrinks the trigger zone around the viewport (`200px` bottom margin here means it starts triggering 200px before the element would otherwise enter view) | JS constant |
| `animation-duration` | Reveal speed (1.2s) | CSS |
| `translateX(±64px)` | Slide distance | CSS keyframes |

## Source

Adapted from `assets/reveal-on-scroll.js` and `sections/custom-media-with-content.liquid` in this repo (skanzen.ro), which credits the general "editorial reveal" pattern to https://www.danielcastle.ro.
