import { convertMoneyToMinorUnits, formatMoney } from '@theme/money-formatting';

/**
 * A two-handle price range slider that stays in sync with the native
 * price-facet-component's own min/max text inputs, rather than replacing
 * their filtering logic. On drag it live-updates the paired text input's
 * value and the visual fill bar; on release it dispatches a real `change`
 * event on that text input, which is exactly what price-facet-component
 * already listens for (see its `on:change` binding in
 * snippets/price-filter.liquid) to apply the filter -- so this needs no
 * knowledge of how filtering actually works, and typing directly into the
 * text inputs still keeps the slider handles in sync too.
 *
 * Everything here is in MINOR UNITS (bani/cents), matching how the native
 * component represents money internally, and conversion to/from the
 * displayed text uses the theme's own money-formatting helpers -- the
 * same ones facets.js uses.
 *
 * That last part matters more than it looks. An earlier version used
 * parseFloat() to read these inputs and toFixed(2) to write them, which
 * silently corrupts money in any locale whose separators aren't
 * en-US's. This shop renders RO format, so a max price of 17200 displays
 * as "17.200,00" -- and parseFloat("17.200,00") is 17.2, not 17200,
 * because it reads the "." as a decimal point and stops at the comma.
 * Writing "93.00" back into a field the theme parses as RO had the
 * mirror-image problem (a "." there is a thousands separator, i.e. 9300).
 * Both only surface once a value crosses into thousands-separator
 * territory or the native component reformats a field, which is why it
 * presented as "works, then breaks a few adjustments in".
 *
 * The two <input type="range"> elements are invisible (opacity: 0) --
 * they exist purely to drive dragging/keyboard/accessibility. The round
 * handles a person actually sees are plain divs (data-slider-handle-min/
 * max) that this class positions as a percentage.
 *
 * Re-initializes on a MutationObserver rather than relying on
 * connectedCallback alone: applying a filter re-renders this section via
 * the theme's Section Rendering morph, which reuses this element's own
 * instance instead of recreating it, so connectedCallback never fires
 * again and anything cached from the first run goes stale.
 */
class DalbePriceSlider extends HTMLElement {
  /** @type {MutationObserver | undefined} */
  #mutationObserver;

  /**
   * The slider's visual scale (upper bound, in minor units), captured on
   * the first render and then held fixed for this element's lifetime.
   *
   * Deliberately NOT re-read from each render's `max` attribute:
   * filter.range_max is whatever the server reports for the current
   * request, and it is not guaranteed to be identical between the initial
   * page render and the later AJAX re-render that applying a filter
   * triggers. When those disagree, the entire track silently rescales
   * underneath the handles -- so a trivial adjustment (e.g. nudging the
   * max from 640 to 610) can leave both handles collapsed into a single
   * blob at the far left, looking frozen and impossible to drag apart,
   * even though every value involved is correct. Pinning the scale means
   * a given price always maps to the same position for as long as the
   * page is open. Stored on the instance rather than an attribute because
   * the instance is what reliably survives the morph.
   *
   * @type {number | undefined}
   */
  #scaleMax;

  connectedCallback() {
    this.#init();

    const priceFacet = this.closest('price-facet-component');
    if (!priceFacet) return;

    this.#mutationObserver = new MutationObserver(this.#init);
    this.#mutationObserver.observe(priceFacet, {
      childList: true,
      subtree: true,
      attributes: true,
      // Restricted to 'value' -- this element only ever writes inline
      // `style`, which isn't in this filter, so our own writes can't
      // retrigger the observer.
      attributeFilter: ['value'],
    });
  }

  disconnectedCallback() {
    this.#mutationObserver?.disconnect();
    this.#detachListeners();
  }

  #detachListeners() {
    this.minRange?.removeEventListener('input', this.#onMinRangeInput);
    this.maxRange?.removeEventListener('input', this.#onMaxRangeInput);
    this.minRange?.removeEventListener('change', this.#commitMin);
    this.maxRange?.removeEventListener('change', this.#commitMax);
    this.minText?.removeEventListener('change', this.#syncFromText);
    this.maxText?.removeEventListener('change', this.#syncFromText);
  }

  /**
   * Extracts just the amount placeholder from the shop's money format,
   * dropping any currency symbol/suffix -- these inputs show bare numbers
   * (the currency symbol is a separate label). Mirrors the same helper in
   * facets.js so both produce identically formatted strings.
   * @param {string} format
   * @returns {string}
   */
  #amountPlaceholder(format) {
    const match = format.match(/{{\s*\w+\s*}}/);
    return match ? match[0] : '{{amount}}';
  }

  /**
   * (Re-)acquires references to the current DOM nodes and wires them up.
   * Safe to call repeatedly.
   */
  #init = () => {
    this.#detachListeners();

    this.minRange = this.querySelector('[data-slider-min]');
    this.maxRange = this.querySelector('[data-slider-max]');
    this.fill = this.querySelector('[data-slider-fill]');
    this.minHandle = this.querySelector('[data-slider-handle-min]');
    this.maxHandle = this.querySelector('[data-slider-handle-max]');

    const priceFacet = this.closest('price-facet-component');
    this.minText = priceFacet?.querySelector('[ref="minInput"]');
    this.maxText = priceFacet?.querySelector('[ref="maxInput"]');

    if (!this.minRange || !this.maxRange || !this.minText || !this.maxText) return;

    this.currency = priceFacet?.dataset.currency ?? 'RON';
    this.moneyFormat = this.#amountPlaceholder(priceFacet?.dataset.moneyFormat ?? '{{amount}}');

    this.#applyScale();

    this.minRange.addEventListener('input', this.#onMinRangeInput);
    this.maxRange.addEventListener('input', this.#onMaxRangeInput);
    this.minRange.addEventListener('change', this.#commitMin);
    this.maxRange.addEventListener('change', this.#commitMax);

    this.minText.addEventListener('change', this.#syncFromText);
    this.maxText.addEventListener('change', this.#syncFromText);

    this.#syncFromText();
  };

  /**
   * Reads a displayed money string into minor units. Locale-aware on
   * purpose: whatever the server rendered into these fields came through
   * `money_without_currency`, so in this shop's RO locale it looks like
   * "1.234,56" -- period thousands, comma decimal.
   * @param {string} text @param {number} fallback
   */
  #parse(text, fallback) {
    const parsed = convertMoneyToMinorUnits(text, this.currency);
    return parsed == null ? fallback : parsed;
  }

  /** How many minor units make one major unit (100 for RON/EUR/USD, 1 for JPY). */
  get #divisor() {
    return convertMoneyToMinorUnits('1', this.currency) || 100;
  }

  /**
   * Writes minor units back out as a CANONICAL number -- plain digits with
   * a dot decimal and no thousands separator ("1234.56").
   *
   * Deliberately NOT formatMoney()/locale format, even though these fields
   * display money. These are the native filter's own inputs, so whatever
   * sits in them is what gets serialized into `filter.v.price.gte/lte`,
   * and Shopify does not parse a comma decimal there -- it strips the
   * separator, so a locale-formatted "793,29" is read as 79329, i.e. 100x
   * too big. That inflation then feeds back into range_max and collapses
   * the whole slider. This is a known upstream bug in Shopify's own
   * reference theme for comma-decimal currencies:
   * https://github.com/Shopify/dawn/issues/255
   *
   * So: parse locale-aware (above), write canonical (here). The visible
   * cost is that these two inputs show "1234.56" rather than "1.234,56".
   * @param {number} minorUnits
   */
  #format(minorUnits) {
    const divisor = this.#divisor;
    const decimals = Math.max(0, String(divisor).length - 1);
    return (minorUnits / divisor).toFixed(decimals);
  }

  /**
   * Captures the scale once, then re-asserts it onto both range inputs on
   * every subsequent render so a differing server-reported `max` can't
   * move the handles. `expandTo` lets a legitimately larger value grow the
   * scale (never shrink it) -- clamping a real filter value to a stale
   * ceiling would be worse than a slightly roomier track.
   * @param {number} [expandTo]
   */
  #applyScale(expandTo) {
    const rendered = Number(this.maxRange.getAttribute('max')) || 0;

    if (this.#scaleMax == null && rendered > 0) this.#scaleMax = rendered;
    if (expandTo != null && this.#scaleMax != null && expandTo > this.#scaleMax) {
      this.#scaleMax = expandTo;
    }
    if (this.#scaleMax == null) return;

    const scale = String(this.#scaleMax);
    // Setting .max before .value matters: the browser clamps value to max.
    if (this.minRange.max !== scale) this.minRange.max = scale;
    if (this.maxRange.max !== scale) this.maxRange.max = scale;
  }

  get #bounds() {
    return {
      lower: Number(this.minRange.min) || 0,
      // Parens are required, not stylistic: mixing ?? with || without
      // them is a SyntaxError, which aborts parsing of the rest of this
      // class body.
      upper: this.#scaleMax ?? (Number(this.minRange.max) || 0),
    };
  }

  /**
   * Treats the text inputs as the source of truth and mirrors them onto
   * the range inputs. Used both on (re)init after a morph and whenever
   * someone types a value directly -- an empty field means "unbounded on
   * that side", so it falls back to the corresponding range bound.
   */
  #syncFromText = () => {
    const { lower, upper } = this.#bounds;

    const minValue = this.#parse(this.minText.value, lower);
    const maxValue = this.#parse(this.maxText.value, upper);

    // Grow the scale first if either value sits above it, so assigning
    // .value below can't get clamped by a too-small max.
    this.#applyScale(Math.max(minValue, maxValue));

    this.minRange.value = String(minValue);
    this.maxRange.value = String(maxValue);

    // Rewrite whatever the server rendered into canonical form, so a
    // submit that never touches the slider still can't send a comma
    // decimal (see #format). Empty stays empty -- that means "unbounded
    // on this side", and filling it in would apply a filter nobody asked
    // for.
    if (this.minText.value.trim()) this.minText.value = this.#format(minValue);
    if (this.maxText.value.trim()) this.maxText.value = this.#format(maxValue);

    this.#updateFill();
  };

  #onMinRangeInput = () => {
    if (Number(this.minRange.value) > Number(this.maxRange.value)) {
      this.minRange.value = this.maxRange.value;
    }
    this.minText.value = this.#format(Number(this.minRange.value));
    this.#updateFill();
  };

  #onMaxRangeInput = () => {
    if (Number(this.maxRange.value) < Number(this.minRange.value)) {
      this.maxRange.value = this.minRange.value;
    }
    this.maxText.value = this.#format(Number(this.maxRange.value));
    this.#updateFill();
  };

  /** Fires the real filter-apply change event only on release, not every drag frame. */
  #commitMin = () => {
    this.minText.dispatchEvent(new Event('change', { bubbles: true }));
  };

  #commitMax = () => {
    this.maxText.dispatchEvent(new Event('change', { bubbles: true }));
  };

  #updateFill() {
    const { lower, upper } = this.#bounds;
    const range = upper - lower || 1;
    const minPercent = ((Number(this.minRange.value) - lower) / range) * 100;
    const maxPercent = ((Number(this.maxRange.value) - lower) / range) * 100;

    if (this.fill) {
      this.fill.style.left = `${minPercent}%`;
      this.fill.style.width = `${Math.max(0, maxPercent - minPercent)}%`;
    }

    if (this.minHandle) this.minHandle.style.left = `${minPercent}%`;
    if (this.maxHandle) this.maxHandle.style.left = `${maxPercent}%`;
  }
}

if (!customElements.get('dalbe-price-slider')) {
  customElements.define('dalbe-price-slider', DalbePriceSlider);
}
