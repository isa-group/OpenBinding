import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LanguageNav } from '../../pages/Profiles/languageSections';
import { SectionNav } from './SectionNav';

describe('section navigation', () => {
  it('links the language navigation to the extensions and to no examples', () => {
    render(<MemoryRouter><LanguageNav current="profiles" /></MemoryRouter>);
    expect(screen.queryByRole('link', { name: 'Examples' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Extensions' })).toHaveAttribute('href', '/language/extensions');
  });

  it('renders the current item of a generic navigation as text and the others as links', () => {
    const items = [
      { id: 'a', label: 'Alpha', to: '/a' },
      { id: 'b', label: 'Beta', to: '/b' },
    ];
    render(<MemoryRouter><SectionNav label="Letters" items={items} current="b" /></MemoryRouter>);
    const nav = screen.getByRole('navigation', { name: 'Letters' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Alpha']);
    expect(within(nav).getByText('Beta').tagName).toBe('SPAN');
    expect(within(nav).getByText('Beta')).toHaveAttribute('aria-current', 'page');
  });
});
