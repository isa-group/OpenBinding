import type { Page } from '@playwright/test';

// What the QA gallery looks at on every page before and after the picture is taken: whether the screen finished loading, and a set of
// measurements (overflow, clipped text, contrast, language, leftovers of the prototype) that a person reviewing the pictures would
// otherwise have to guess from pixels. The measurements are written next to the pictures' run, never into the repository.

/** What still says the screen is waiting for something. */
const WAITING = '.ui-skeleton, [aria-busy="true"], .route-loading, [class*="spinner" i], [class*="skeleton" i]:not(.ui-skeleton)';

export async function waitUntilSettled(page: Page): Promise<string[]> {
  const notes: string[] = [];
  try {
    await page.waitForFunction((selector) => !document.querySelector(selector), WAITING, { timeout: 30_000 });
  } catch {
    notes.push('still waiting after 30 s (skeleton, spinner or aria-busy)');
  }
  await page.evaluate(() => document.fonts.ready);
  // Effects that start from the first answer (a second request, a chart measuring itself) get a moment, then the check is repeated.
  await page.waitForTimeout(500);
  const left = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((element) => `${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0]}`).slice(0, 5), WAITING);
  if (left.length) notes.push(`loading markers left: ${left.join(', ')}`);
  return notes;
}

export async function prepareCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.scrollTo(0, 0);
    for (const element of document.querySelectorAll('main, #platform-main, #main-content')) (element as HTMLElement).scrollTop = 0;
  });
  await page.mouse.move(0, 0);
}

export interface PageMeasure {
  title: string;
  h1: string[];
  h1Font: string | null;
  /** Section and card headings (h2-h6) set in the display face: the prototype sets only the screen title in it. */
  displayHeadings: string[];
  overflowX: number;
  offenders: string[];
  clipped: string[];
  lowContrast: string[];
  darkSurfaces: string[];
  alerts: string[];
  spanish: string[];
  placeholders: string[];
  prototypeLeftovers: string[];
  overlays: string[];
  brokenImages: string[];
  emptyControls: string[];
  brand: { header: number; footer: number; mobileMenu: number };
  projectTabs: { present: boolean; scrolls: boolean; visible: number; total: number };
  textLength: number;
}

/** Everything measured in the page, in one pass. */
export async function measurePage(page: Page): Promise<PageMeasure> {
  return page.evaluate(() => {
    const describe = (element: Element) => {
      const classes = String(element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`;
    };
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0;
    };
    const inScrollContainer = (element: Element) => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden' || overflowX === 'clip') return true;
      }
      return false;
    };
    const parse = (value: string) => {
      // `color-mix()` computes to `color(srgb 0.1 0.4 0.7)` (channels 0..1, optional `/ alpha`).
      const mixed = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(value);
      if (mixed) return { r: Number(mixed[1]) * 255, g: Number(mixed[2]) * 255, b: Number(mixed[3]) * 255, a: mixed[4] === undefined ? 1 : Number(mixed[4]) };
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (!match) return null;
      const [r, g, b, a] = match[1].split(',').map((part) => Number.parseFloat(part));
      return { r, g, b, a: a === undefined ? 1 : a };
    };
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const channel = (value: number) => {
        const unit = value / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const backgroundOf = (element: Element) => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        const colour = parse(getComputedStyle(node).backgroundColor);
        if (colour && colour.a > 0.95) return colour;
        if (getComputedStyle(node).backgroundImage !== 'none') return null;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };

    const body = document.body;
    const text = (body.innerText ?? '').replace(/\s+/g, ' ');
    const wide = window.innerWidth;

    const offenders: string[] = [];
    for (const element of body.querySelectorAll('*')) {
      if (offenders.length >= 8) break;
      if (['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK'].includes(element.tagName)) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || !visible(element)) continue;
      // What a closed <details> holds is laid out but not shown.
      const closed = element.closest('details:not([open])');
      if (closed && !element.closest('summary') && element !== closed) continue;
      if ((box.right > wide + 1 || box.left < -1) && !inScrollContainer(element) && getComputedStyle(element).position !== 'fixed') {
        offenders.push(`${describe(element)} left=${Math.round(box.left)} right=${Math.round(box.right)}`);
      }
    }

    const clipped: string[] = [];
    for (const element of body.querySelectorAll('h1, h2, h3, h4, p, span, a, button, li, td, th, label, dd, dt, strong, small, code')) {
      if (clipped.length >= 10) break;
      if (!visible(element) || !(element.textContent ?? '').trim() || element.closest('.sr-only')) continue;
      const style = getComputedStyle(element);
      const hides = ['hidden', 'clip'].includes(style.overflowX);
      if (hides && element.scrollWidth > element.clientWidth + 1 && style.textOverflow !== 'ellipsis') {
        clipped.push(`${describe(element)} "${(element.textContent ?? '').trim().slice(0, 40)}" (${element.scrollWidth}>${element.clientWidth})`);
      }
    }

    const lowContrast: string[] = [];
    const seen = new Set<string>();
    for (const element of body.querySelectorAll('h1, h2, h3, h4, p, span, a, button, li, td, th, label, dd, dt, strong, small, summary, legend, figcaption')) {
      if (lowContrast.length >= 10) break;
      if (![...element.childNodes].some((child) => child.nodeType === 3 && (child.textContent ?? '').trim())) continue;
      // Decorative glyphs (an arrow between two chips, a bullet) are hidden from assistive technology and carry no information.
      if (!visible(element) || element.closest('[aria-hidden="true"]') || element.closest(':disabled, [aria-disabled="true"]')) continue;
      const box = element.getBoundingClientRect();
      if (box.bottom < 0 || box.top > window.innerHeight) continue;
      const style = getComputedStyle(element);
      const foreground = parse(style.color);
      const background = backgroundOf(element);
      if (!foreground || !background) continue;
      const a = luminance(foreground);
      const b = luminance(background);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      const needed = large ? 3 : 4.5;
      const key = `${describe(element)}|${style.color}|${ratio.toFixed(1)}`;
      if (ratio < needed && !seen.has(key) && foreground.a > 0.9) {
        seen.add(key);
        lowContrast.push(`${describe(element)} "${(element.textContent ?? '').trim().slice(0, 30)}" ${ratio.toFixed(2)}:1 (${style.color} on rgb(${background.r},${background.g},${background.b}))`);
      }
    }

    const darkSurfaces: string[] = [];
    for (const element of body.querySelectorAll('header, nav, main *, footer, aside, section, div')) {
      if (darkSurfaces.length >= 8) break;
      if (element.closest('pre, code, .cm-editor, svg, canvas, [class*="code" i], [class*="editor" i], [class*="chart" i], [class*="terminal" i], [class*="pre" i]')) continue;
      const colour = parse(getComputedStyle(element).backgroundColor);
      // Dark neutrals only: the deep brand blue (more blue than red) is a design colour, not a leftover of a dark theme.
      if (!colour || colour.a < 0.5 || luminance(colour) > 0.12 || colour.b > colour.r + 30) continue;
      const box = element.getBoundingClientRect();
      if (box.width * box.height < 3000 || box.bottom < 0 || box.top > window.innerHeight || !visible(element)) continue;
      darkSurfaces.push(`${describe(element)} ${getComputedStyle(element).backgroundColor} ${Math.round(box.width)}x${Math.round(box.height)}`);
    }

    const spanishWords = /\b(del|los|las|para|una|uno|por|con|que|desde|hasta|sin|sobre|este|esta|más|está|también|nuevo|nueva|crear|buscar|guardar|cancelar|aceptar|resultados|usuario|contraseña|cuenta|bienvenido|inicio|ajustes|proyecto|proyectos|ejecutar|ayuda)\b/gi;
    const spanish = [...text.matchAll(spanishWords)].slice(0, 6).map((match) => text.slice(Math.max(0, (match.index ?? 0) - 20), (match.index ?? 0) + 30));
    for (const match of text.matchAll(/[áéíóúñ¿¡]/gi)) {
      if (spanish.length >= 8) break;
      spanish.push(`accent: ${text.slice(Math.max(0, (match.index ?? 0) - 20), (match.index ?? 0) + 20)}`);
    }

    const placeholders = [...text.matchAll(/\b(TODO|FIXME|lorem|ipsum|placeholder|coming soon|sample text|foo bar)\b/gi)].slice(0, 6)
      .map((match) => text.slice(Math.max(0, (match.index ?? 0) - 20), (match.index ?? 0) + 30));

    const prototypeLeftovers: string[] = [];
    if (document.querySelector('[class*="shell-sim" i], [class*="shellsim" i], [class*="sim-bar" i], [data-shell-sim], [data-persona], [class*="persona" i]')) prototypeLeftovers.push('persona / ShellSimBar element');
    for (const match of text.matchAll(/\b(ShellSim|persona switcher|Lucía|Iker Mora|Marco Díaz|Sofía Rey|Nora Campos|being rebuilt)\b/gi)) {
      prototypeLeftovers.push(text.slice(Math.max(0, (match.index ?? 0) - 15), (match.index ?? 0) + 25));
    }

    const overlays = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="cookie" i], [class*="consent" i], [class*="overlay" i], [class*="backdrop" i]')]
      .filter(visible).map(describe).slice(0, 4);

    const brokenImages = [...document.images].filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.getAttribute('src') ?? '?').slice(0, 5);

    const emptyControls = [...document.querySelectorAll('a[href], button')].filter((control) => {
      if (!visible(control)) return false;
      const label = (control.textContent ?? '').trim() || control.getAttribute('aria-label') || control.getAttribute('title') || control.querySelector('img[alt]:not([alt=""])');
      return !label;
    }).map(describe).slice(0, 5);

    const h1 = [...document.querySelectorAll('h1')];

    const tabs = document.querySelector('nav[aria-label="Project sections"]');
    const tabLinks = tabs ? [...tabs.querySelectorAll('a')] : [];
    const tabsBox = tabs?.getBoundingClientRect();
    const visibleTabs = tabLinks.filter((link) => {
      const box = link.getBoundingClientRect();
      return tabsBox ? box.left >= tabsBox.left - 1 && box.right <= tabsBox.right + 1 : false;
    });

    return {
      title: document.title,
      h1: h1.map((heading) => (heading.textContent ?? '').trim()),
      h1Font: h1[0] ? getComputedStyle(h1[0]).fontFamily : null,
      displayHeadings: [...document.querySelectorAll('h2, h3, h4, h5, h6')]
        .filter((heading) => visible(heading) && getComputedStyle(heading).fontFamily.includes('PP Editorial'))
        .map((heading) => `${describe(heading)} "${(heading.textContent ?? '').trim().slice(0, 30)}"`).slice(0, 6),
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      offenders,
      clipped,
      lowContrast,
      darkSurfaces,
      alerts: [...document.querySelectorAll('[role="alert"]')].map((alert) => (alert.textContent ?? '').trim().slice(0, 120)).slice(0, 4),
      spanish,
      placeholders,
      prototypeLeftovers,
      overlays,
      brokenImages,
      emptyControls,
      brand: {
        header: document.querySelectorAll('.app-header .institution-mark, .site-header .institution-mark').length,
        footer: document.querySelectorAll('.site-footer .institution-mark').length,
        mobileMenu: document.querySelectorAll('.app-mobile-menu .institution-mark').length,
      },
      projectTabs: {
        present: Boolean(tabs),
        scrolls: tabs ? tabs.scrollWidth > tabs.clientWidth + 1 : false,
        visible: visibleTabs.length,
        total: tabLinks.length,
      },
      textLength: text.length,
    };
  });
}
