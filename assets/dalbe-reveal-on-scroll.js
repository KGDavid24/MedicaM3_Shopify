/**
 * <dalbe-reveal-on-scroll> wraps a media + content pair (the detailed
 * dalbe-process-steps cards) and animates each side in from its own edge
 * the first time it scrolls into view — image from whichever side it sits
 * on, content from the opposite side. Fires once per element, then stops
 * observing. Ported from animated-reveal-cards.md (skanzen.ro pattern).
 */

const OBSERVER_OPTIONS = {
  threshold: 0,
  rootMargin: '0px 0px 200px 0px',
};

const STAGGER_MS = 100;

class DalbeRevealOnScroll extends HTMLElement {
  #observer;

  connectedCallback() {
    if (this.dataset.animate === 'false') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const mediaRight = this.dataset.mediaSide === 'right';
    const media = this.querySelector('.dalbe-process-steps__media');
    const content = this.querySelector('.dalbe-process-steps__item-content');

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

if (!customElements.get('dalbe-reveal-on-scroll')) {
  customElements.define('dalbe-reveal-on-scroll', DalbeRevealOnScroll);
}
