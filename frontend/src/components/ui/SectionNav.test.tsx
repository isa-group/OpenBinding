import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ExploreNav, LanguageNav } from './SectionNav';

describe('section navigation', () => {
  // [utest->req~frontend-nav-examples-in-explore~1]
  it('marks BIM examples as the current Explore section', () => {
    render(<MemoryRouter><ExploreNav current="examples" /></MemoryRouter>);
    const nav = screen.getByRole('navigation', { name: 'Explore' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Public work', 'BIM examples']);
    expect(within(nav).getByRole('link', { name: 'BIM examples' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'BIM examples' })).toHaveAttribute('href', '/explore/examples');
    expect(within(nav).getByRole('link', { name: 'Public work' })).toHaveAttribute('href', '/explore');
    expect(within(nav).getByRole('link', { name: 'Public work' })).not.toHaveAttribute('aria-current');
  });

  // [utest->req~frontend-nav-examples-in-explore~1]
  it('marks Public work on the Explore page itself', () => {
    render(<MemoryRouter><ExploreNav current="public" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Public work' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'BIM examples' })).not.toHaveAttribute('aria-current');
  });

  // [utest->req~frontend-nav-examples-in-explore~1]
  it('links the language navigation to the examples in Explore', () => {
    render(<MemoryRouter><LanguageNav current="profiles" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Examples' })).toHaveAttribute('href', '/explore/examples');
  });
});
