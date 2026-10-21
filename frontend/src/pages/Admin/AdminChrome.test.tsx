import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminFrame } from './AdminChrome';
import { ADMIN_SECTIONS } from './adminModel';

describe('AdminFrame', () => {
  it('lists every administration section, the current one not a link', () => {
    render(<MemoryRouter><AdminFrame section="queues" trail={[{ label: 'Queues' }]} title="Queues">content</AdminFrame></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: 'Administration' });
    expect(within(nav).getAllByRole('link')).toHaveLength(ADMIN_SECTIONS.length - 1);
    expect(within(nav).getByText('Queues')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Queues' })).toBeInTheDocument();
  });

  describe('on a phone, where the sections are one row that scrolls', () => {
    const scrolled: Array<{ left: number }> = [];
    const box = (left: number, width: number) => ({ left, width, right: left + width, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

    beforeEach(() => {
      scrolled.length = 0;
      vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(900);
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(390);
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
        return this.tagName === 'NAV' ? box(0, 390) : box(600, 90);
      });
      Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value(options: { left: number }) { scrolled.push(options); } });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      Reflect.deleteProperty(Element.prototype, 'scrollTo');
    });

    it('centres the current section in the row', () => {
      render(<MemoryRouter><AdminFrame section="maintenance" trail={[{ label: 'Maintenance' }]} title="Maintenance">content</AdminFrame></MemoryRouter>);

      // 600 to the pill - (390 row - 90 pill) / 2
      expect(scrolled).toEqual([{ left: 450 }]);
    });
  });
});
