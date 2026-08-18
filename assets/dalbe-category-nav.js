/**
 * Custom element powering the dalbe-category-nav section.
 *
 * Desktop (>=990px): hovering a category with a flyout swaps the visible
 * flyout panel; leaving both the trigger and the flyout closes it after a
 * short delay so a diagonal mouse path doesn't flicker it shut.
 *
 * Mobile (<990px): the whole panel is a drawer toggled by the trigger
 * button. Categories with a flyout get a separate expand/collapse button
 * so the category link itself still navigates normally.
 */

const DESKTOP_BREAKPOINT = '(min-width: 990px)';
const CLOSE_DELAY_MS = 200;

class DalbeCategoryNav extends HTMLElement {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #closeTimer;

  /** @type {number} */
  #lockedScrollY = 0;

  connectedCallback() {
    this.trigger = this.querySelector('[data-trigger]');
    this.closeButton = this.querySelector('[data-close]');
    this.backdrop = this.querySelector('[data-backdrop]');
    this.panel = this.querySelector('[data-panel]');
    this.flyout = this.querySelector('[data-flyout]');
    this.categoryTriggers = this.querySelectorAll('[data-category-trigger]');
    this.expandToggles = this.querySelectorAll('[data-expand-toggle]');

    this.trigger?.addEventListener('click', this.#openDrawer);
    this.closeButton?.addEventListener('click', this.#closeDrawer);
    this.backdrop?.addEventListener('click', this.#closeDrawer);

    this.categoryTriggers.forEach((item) => {
      item.addEventListener('pointerenter', () => this.#activateFlyout(item));
      item.addEventListener('focusin', () => this.#activateFlyout(item));
    });

    this.panel?.addEventListener('pointerleave', this.#scheduleFlyoutClose);
    this.panel?.addEventListener('focusout', this.#scheduleFlyoutClose);

    this.expandToggles.forEach((button) => {
      button.addEventListener('click', () => this.#toggleAccordion(button));
    });

    this.addEventListener('keydown', this.#onKeydown);
  }

  #openDrawer = () => {
    // dalbe: on the homepage the panel is locked permanently open via CSS
    // (see [data-locked-open] in dalbe-category-nav.liquid) — but that
    // "always visible beside the hero" behavior is desktop-only (the CSS
    // rule it relies on only applies at >=990px). On mobile there's no
    // permanently-open panel, so the trigger must still open/close the
    // drawer normally even on the homepage — bailing out unconditionally
    // here made the button do nothing at all on the mobile homepage.
    if (this.hasAttribute('data-locked-open') && window.matchMedia(DESKTOP_BREAKPOINT).matches) return;

    if (window.matchMedia(DESKTOP_BREAKPOINT).matches && this.hasAttribute('data-open')) {
      this.#closeDrawer();
      return;
    }

    this.setAttribute('data-open', '');
    this.trigger?.setAttribute('aria-expanded', 'true');
    this.#lockBodyScroll();
  };

  #closeDrawer = () => {
    this.removeAttribute('data-open');
    this.trigger?.setAttribute('aria-expanded', 'false');
    this.#unlockBodyScroll();
  };

  /**
   * dalbe: `overflow: hidden` on body/html blocks mouse-wheel scrolling
   * but is well known to NOT reliably block touch-driven panning on real
   * mobile browsers (iOS Safari in particular) -- a finger starting on
   * the narrow visible backdrop strip still scrolled the page underneath
   * despite that CSS being in place. Pinning body to position:fixed at
   * its current scroll offset is the standard, actually-reliable fix:
   * there's no scrollable box left for touch panning to act on. Desktop-
   * gated because the panel there is a hover flyout, not a full-screen
   * drawer -- locking scroll behind it would be unexpected.
   */
  #lockBodyScroll() {
    if (window.matchMedia(DESKTOP_BREAKPOINT).matches) return;

    this.#lockedScrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${this.#lockedScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
  }

  /** Safe to call even if never locked -- resetting already-empty inline styles is a no-op. */
  #unlockBodyScroll() {
    const wasLocked = document.body.style.position === 'fixed';
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';

    if (wasLocked) {
      // dalbe: force a synchronous reflow before scrolling -- immediately
      // after removing position:fixed, the layout engine hasn't
      // necessarily recalculated the document's restored (in-flow)
      // height yet, so scrollTo can silently clamp back to 0 as if the
      // page were still only viewport-tall. Reading offsetHeight forces
      // that recalculation to happen first.
      void document.body.offsetHeight;
      window.scrollTo(0, this.#lockedScrollY);
    }
  }

  #onKeydown = (/** @type {KeyboardEvent} */ event) => {
    if (event.key === 'Escape') this.#closeDrawer();
  };

  /** @param {Element} item */
  #activateFlyout(item) {
    if (!window.matchMedia(DESKTOP_BREAKPOINT).matches) return;

    clearTimeout(this.#closeTimer);
    const key = item.getAttribute('data-category-trigger');

    this.categoryTriggers.forEach((el) => el.toggleAttribute('data-active', el === item));

    this.flyout?.querySelectorAll('[data-category-panel]').forEach((panel) => {
      panel.hidden = panel.getAttribute('data-category-panel') !== key;
    });
    this.flyout?.setAttribute('data-open', '');
  }

  #scheduleFlyoutClose = (/** @type {FocusEvent | PointerEvent} */ event) => {
    if (!window.matchMedia(DESKTOP_BREAKPOINT).matches) return;

    const related = /** @type {Node | null} */ (event.relatedTarget ?? null);
    if (related && this.panel?.contains(related)) return;

    clearTimeout(this.#closeTimer);
    this.#closeTimer = setTimeout(() => {
      this.categoryTriggers.forEach((el) => el.removeAttribute('data-active'));
      this.flyout?.removeAttribute('data-open');
      this.flyout?.querySelectorAll('[data-category-panel]').forEach((panel) => {
        panel.hidden = true;
      });
    }, CLOSE_DELAY_MS);
  };

  /** @param {Element} button */
  #toggleAccordion(button) {
    const accordion = button.parentElement?.querySelector('[data-accordion]');
    if (!accordion) return;

    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', (!expanded).toString());
    accordion.hidden = expanded;
  }

  disconnectedCallback() {
    clearTimeout(this.#closeTimer);
  }
}

if (!customElements.get('dalbe-category-nav')) {
  customElements.define('dalbe-category-nav', DalbeCategoryNav);
}
