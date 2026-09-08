import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Navigation } from './Navigation';

vi.mock('../../contexts/auth', () => ({
  useAuth: () => ({ user: null, isAdmin: false, signOut: vi.fn() }),
}));
vi.mock('../../contexts/theme', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}));

describe('Navigation dropdowns', () => {
  it('closes the previous dropdown when another one opens', () => {
    render(<MemoryRouter><Navigation /></MemoryRouter>);

    const menus = screen.getAllByRole('group');
    const exploreMenu = menus[0] as HTMLDetailsElement;
    const toolsMenu = menus[1] as HTMLDetailsElement;

    fireEvent.click(exploreMenu.querySelector('summary')!);
    expect(exploreMenu.open).toBe(true);

    fireEvent.click(toolsMenu.querySelector('summary')!);
    expect(exploreMenu.open).toBe(false);
    expect(toolsMenu.open).toBe(true);
  });

  it('closes open dropdowns when clicking outside the navigation', () => {
    render(<MemoryRouter><Navigation /></MemoryRouter>);

    const exploreMenu = screen.getAllByRole('group')[0] as HTMLDetailsElement;
    fireEvent.click(exploreMenu.querySelector('summary')!);
    expect(exploreMenu.open).toBe(true);

    fireEvent.pointerDown(document.body);
    expect(exploreMenu.open).toBe(false);
  });

  it('renders the About BIM dropdown label', () => {
    render(<MemoryRouter><Navigation /></MemoryRouter>);
    expect(screen.getAllByText('About BIM').length).toBeGreaterThan(0);
  });
});
