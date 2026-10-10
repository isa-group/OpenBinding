import { useEffect, type RefObject } from 'react';

/**
 * A navigation that becomes one row that scrolls sideways on a narrow screen: the current entry is centred in that row, so a reader who
 * arrives on the fourth screen of five sees where they are. Only the row moves; the page does not. Where the row does not scroll (a wide
 * screen, or the unit-test DOM, which has no layout) there is nothing to do.
 */
export function useCurrentIntoView(nav: RefObject<HTMLElement | null>, current: string) {
  useEffect(() => {
    const row = nav.current;
    const link = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !link || row.scrollWidth <= row.clientWidth) return;
    const rowBox = row.getBoundingClientRect();
    const linkBox = link.getBoundingClientRect();
    const centred = row.scrollLeft + (linkBox.left - rowBox.left) - (row.clientWidth - linkBox.width) / 2;
    row.scrollTo?.({ left: Math.max(0, centred) });
  }, [nav, current]);
}
