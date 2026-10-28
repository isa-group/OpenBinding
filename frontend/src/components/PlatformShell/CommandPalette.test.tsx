import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Organization, Project } from '../../api/platform';
import { CommandPalette, OPEN_COMMAND_PALETTE_EVENT } from './CommandPalette';
import { buildCommands } from './paletteCommands';

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

// What the palette offers comes from the commands under test, not from names written here: a change to the screens a command leads to
// edits paletteCommands.ts and leaves these tests alone.
const commandsOf = (isAdmin: boolean) => buildCommands({ organizations: [organization], projects: [project], organization, project, isAdmin });
const pathOf = (href: string) => new URL(href, 'http://localhost').pathname;

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
    const commands = commandsOf(false);
    const tools = commands.filter((command) => command.group === 'Tools');
    expect(tools.length).toBeGreaterThan(1);
    const [first] = tools;
    renderPalette();
    openWithShortcut();
    expect(resultLabels()).toEqual(commands.map((command) => command.label));

    fireEvent.change(search(), { target: { value: first.label.toLowerCase() } });
    expect(resultLabels()).toContain(first.label);
    expect(resultLabels().length).toBeLessThan(commands.length);

    fireEvent.change(search(), { target: { value: first.desc } });
    expect(resultLabels()).toEqual([first.label]);

    fireEvent.change(search(), { target: { value: first.group.toLowerCase() } });
    expect(resultLabels()).toEqual(expect.arrayContaining(tools.map((command) => command.label)));
    expect(resultLabels().length).toBeLessThan(commands.length);
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
    const everyoneLabels = commandsOf(false).map((command) => command.label);
    const adminOnly = commandsOf(true).map((command) => command.label).filter((label) => !everyoneLabels.includes(label));
    expect(adminOnly.length).toBeGreaterThan(0);

    const { unmount } = renderPalette(false);
    openWithShortcut();
    for (const label of adminOnly) expect(resultLabels()).not.toContain(label);
    unmount();

    renderPalette(true);
    openWithShortcut();
    for (const label of adminOnly) expect(resultLabels()).toContain(label);
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
    const [first] = commandsOf(false).filter((command) => command.group === 'Tools');
    renderPalette();
    openWithShortcut();
    fireEvent.change(search(), { target: { value: first.desc } });
    fireEvent.keyDown(search(), { key: 'Enter' });

    expect(screen.getByTestId('location').textContent).toBe(pathOf(first.href));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('navigates and closes when a result is chosen', () => {
    const chosen = commandsOf(false).filter((command) => command.group === 'Account').at(-1);
    if (!chosen) throw new Error('the palette has no account command');
    renderPalette();
    openWithShortcut();
    const link = within(dialog()).getAllByRole('link').find((candidate) => candidate.getAttribute('href') === chosen.href);
    if (!link) throw new Error(`the palette does not list ${chosen.href}`);
    fireEvent.click(link);

    expect(screen.getByTestId('location').textContent).toBe(pathOf(chosen.href));
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
