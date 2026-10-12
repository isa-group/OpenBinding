import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Organization, Project } from '../../api/platform';
import { CommandPalette, OPEN_COMMAND_PALETTE_EVENT } from './CommandPalette';

const organization: Organization = {
  id: 'org-1', name: 'ISA Demo Group', slug: 'isa-demo', parent_id: null,
  billing_sponsor_user_id: 'user-1', effective_role: 'OWNER', created_at: '2026-01-01T00:00:00Z',
};
const project: Project = {
  id: 'project-1', organization_id: 'org-1', slug: 'qos', name: 'QoS Benchmarks', description: '',
  visibility: 'private', created_by_id: 'user-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderPalette(isAdmin = false) {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <button type="button">Opener</button>
      <CommandPalette organizations={[organization]} projects={[project]} organization={organization} project={project} isAdmin={isAdmin} />
      <Location />
    </MemoryRouter>,
  );
}

const openWithShortcut = (init: KeyboardEventInit = { ctrlKey: true }) => fireEvent.keyDown(document.body, { key: 'k', ...init });
const dialog = () => screen.getByRole('dialog', { name: 'Command palette' });
const search = () => screen.getByRole('textbox', { name: 'Search commands and loaded items' });
const resultLabels = () => within(dialog()).queryAllByRole('link').map((link) => link.querySelector('strong')?.textContent);

describe('CommandPalette', () => {
  it('stays closed until it is asked to open', () => {
    renderPalette();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['Ctrl+K', { ctrlKey: true }],
    ['Cmd+K', { metaKey: true }],
  ])('opens with %s, focuses the search box and toggles closed on a second press', (_name, init) => {
    renderPalette();
    openWithShortcut(init);

    expect(dialog()).toHaveAttribute('aria-modal', 'true');
    expect(search()).toHaveFocus();

    openWithShortcut(init);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens from the event the header search button sends', () => {
    renderPalette();
    fireEvent(window, new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
    expect(dialog()).toBeInTheDocument();
  });

  it('filters by label, description and group', () => {
    renderPalette();
    openWithShortcut();
    expect(resultLabels()).toContain('Explore');

    fireEvent.change(search(), { target: { value: 'verif' } });
    expect(resultLabels()).toEqual(['Verifier']);

    fireEvent.change(search(), { target: { value: 'digest' } });
    expect(resultLabels()).toEqual(['Verifier']);

    fireEvent.change(search(), { target: { value: 'tools' } });
    expect(resultLabels()).toEqual(['Verifier', 'My engines', 'Language extensions', 'Generator lab']);
  });

  it('says that search is local when nothing matches', () => {
    renderPalette();
    openWithShortcut();
    fireEvent.change(search(), { target: { value: 'zzzz-not-here' } });

    expect(screen.getByText('No matches. Search only covers data already loaded on this device.')).toBeInTheDocument();
    expect(resultLabels()).toEqual([]);
  });

  it('finds the organizations and projects that are already loaded', () => {
    renderPalette();
    openWithShortcut();

    fireEvent.change(search(), { target: { value: 'qos' } });
    const labels = resultLabels();
    expect(labels).toContain('QoS Benchmarks');
    const projectLink = within(dialog()).getByRole('link', { name: /^QoS Benchmarks/ });
    expect(projectLink).toHaveAttribute('href', '/app/isa-demo/qos');

    fireEvent.change(search(), { target: { value: 'ISA Demo' } });
    expect(within(dialog()).getByRole('link', { name: /^ISA Demo Group/ })).toHaveAttribute('href', '/app/isa-demo');
  });

  it('only offers administration commands to administrators', () => {
    const { unmount } = renderPalette(false);
    openWithShortcut();
    expect(resultLabels()).not.toContain('Administration');
    unmount();

    renderPalette(true);
    openWithShortcut();
    expect(resultLabels()).toContain('Administration');
  });

  it('closes with Escape and gives focus back to the control that was focused', () => {
    renderPalette();
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    openWithShortcut();
    expect(search()).toHaveFocus();

    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('closes from the ESC button', () => {
    renderPalette();
    openWithShortcut();
    fireEvent.click(screen.getByRole('button', { name: 'Close command palette' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the first result with Enter', () => {
    renderPalette();
    openWithShortcut();
    fireEvent.change(search(), { target: { value: 'verifier' } });
    fireEvent.keyDown(search(), { key: 'Enter' });

    expect(screen.getByTestId('location')).toHaveTextContent('/app/verifier');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('navigates and closes when a result is chosen', () => {
    renderPalette();
    openWithShortcut();
    fireEvent.click(within(dialog()).getByRole('link', { name: /^Usage & plan/ }));

    expect(screen.getByTestId('location')).toHaveTextContent('/app/account/usage');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves between the search box and the results with the arrow keys', () => {
    renderPalette();
    openWithShortcut();
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    const [first, second] = within(dialog()).getAllByRole('link');
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: 'ArrowUp' });
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(search()).toHaveFocus();
  });

  it('keeps Tab inside the dialog', () => {
    renderPalette();
    openWithShortcut();

    fireEvent.keyDown(search(), { key: 'Tab', shiftKey: true });
    const links = within(dialog()).getAllByRole('link');
    expect(links[links.length - 1]).toHaveFocus();

    fireEvent.keyDown(links[links.length - 1], { key: 'Tab' });
    expect(search()).toHaveFocus();
  });
});
