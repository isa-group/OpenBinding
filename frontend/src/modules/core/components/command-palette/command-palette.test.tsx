import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CommandPalette, { type PaletteCommand } from '.';

const commands = (go: (to: string) => void): PaletteCommand[] => [
  {
    id: 'home',
    label: 'Home',
    description: 'Your dashboard',
    group: 'Go to',
    action: () => go('/'),
  },
  {
    id: 'engines',
    label: 'Engines',
    description: 'The engine catalog',
    group: 'Go to',
    action: () => go('/engines'),
  },
  {
    id: 'new-org',
    label: 'New organization',
    description: 'Create one',
    group: 'Create',
    action: () => go('/orgs/new'),
  },
];

describe('CommandPalette', () => {
  it('opens with ⌘K or Ctrl+K and lists the commands it is given, under their groups', () => {
    render(<CommandPalette commands={commands(vi.fn())} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByText('Go to')).toBeInTheDocument();
    expect(screen.getByText('Create')).toBeInTheDocument();
  });

  it('filters, moves with the arrows and runs the selected command on Enter', async () => {
    const go = vi.fn();
    render(<CommandPalette commands={commands(go)} />);
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    const input = screen.getByRole('combobox', { name: 'Search commands' });
    fireEvent.change(input, { target: { value: 'e' } });
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      expect.stringContaining('Home'),
      expect.stringContaining('Engines'),
      expect.stringContaining('New organization'),
    ]);
    fireEvent.change(input, { target: { value: 'engine' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    act(() => {
      fireEvent.keyDown(document, { key: 'Enter' });
    });
    expect(go).toHaveBeenCalledWith('/engines');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('says so when nothing matches, and closes on Escape', async () => {
    render(<CommandPalette commands={commands(vi.fn())} />);
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    expect(screen.getByText('No commands found')).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('binds no theme shortcut', () => {
    render(<CommandPalette commands={commands(vi.fn())} />);
    act(() => {
      fireEvent.keyDown(document, { key: 'j', metaKey: true });
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
