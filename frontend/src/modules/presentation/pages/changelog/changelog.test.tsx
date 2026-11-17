import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addressNow, renderModule } from '../../../../test/moduleKit';
import ChangelogPage from '.';
import type { ChangelogData } from './types';

const CHANGELOG: ChangelogData = {
  platform: [
    {
      version: '1.2.0',
      date: '2026-09-06',
      title: 'Add collaborative binding analysis platform',
      changes: ['Share analyses'],
    },
    { version: 'next', date: 'Unreleased', title: 'Upcoming platform work', changes: [] },
  ],
  bim: [
    {
      version: '0.5.0',
      date: '2026-09-20',
      title: 'Binding language and engines',
      changes: ['New engine'],
    },
  ],
  documentation: [
    {
      version: '0.3.0',
      date: '2026-08-01',
      title: 'OpenBinding documentation',
      changes: ['Guides'],
    },
  ],
};

const titles = () =>
  within(screen.getByRole('tabpanel'))
    .getAllByRole('heading', { level: 2 })
    .map(heading => heading.textContent);

describe('ChangelogPage', () => {
  it('shows the platform and its documentation under OpenBinding, unreleased first, then newest first', () => {
    renderModule(<ChangelogPage changelog={CHANGELOG} />, { user: null, entry: '/changelog' });

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'OpenBinding',
      'Language',
    ]);
    expect(screen.getByRole('tab', { name: 'OpenBinding' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(titles()).toEqual([
      'Upcoming platform work',
      'Add collaborative binding analysis platform',
      'OpenBinding documentation',
    ]);
    expect(screen.getByText('Unreleased')).toBeInTheDocument();
    expect(screen.getByText('No changes recorded yet.')).toBeInTheDocument();
    expect(screen.getByText('Sep 6, 2026')).toHaveAttribute('datetime', '2026-09-06');
    expect(screen.getAllByText('Documentation')).toHaveLength(1);
    expect(screen.queryByText('Binding language and engines')).not.toBeInTheDocument();
  });

  it('shows the language under Language, and keeps the tab in the address', () => {
    renderModule(<ChangelogPage changelog={CHANGELOG} />, { user: null, entry: '/changelog' });

    fireEvent.click(screen.getByRole('tab', { name: 'Language' }));

    expect(screen.getByRole('tab', { name: 'Language' })).toHaveAttribute('aria-selected', 'true');
    expect(addressNow()).toBe('/changelog?tab=language');
    expect(titles()).toEqual(['Binding language and engines']);
    expect(screen.getByText('BIM-Engines')).toBeInTheDocument();
    const changes = screen.getByText('Changes').closest('details') as HTMLElement;
    expect(changes).toHaveAttribute('open');
    expect(within(changes).getByText('New engine')).toBeInTheDocument();
  });

  it('opens on the tab of the address, and says when a tab has no release yet', () => {
    renderModule(<ChangelogPage changelog={{ platform: [], bim: [], documentation: [] }} />, {
      user: null,
      entry: '/changelog?tab=language',
    });

    expect(screen.getByRole('tab', { name: 'Language' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Pending editorial review')).toBeInTheDocument();
  });

  it('shows the real changelog', () => {
    renderModule(<ChangelogPage />, { user: null, entry: '/changelog' });

    expect(titles()[0]).toBe(
      'Problems and the laboratory on the shared core: the problem editor, study fronts and presets'
    );
  });
});
