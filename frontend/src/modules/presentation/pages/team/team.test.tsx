import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderModule } from '../../../../test/moduleKit';
import TeamPage from '.';

describe('TeamPage', () => {
  it('shows the reviewed team as SPHERE’s member cards, with their profile links', () => {
    renderModule(<TeamPage />, { user: null, entry: '/team' });

    expect(screen.getByRole('heading', { level: 1, name: 'Team' })).toBeInTheDocument();
    const person = screen.getByRole('article', { name: 'Francisco Javier Cavero López' });
    expect(within(person).getByText('Maintainer · repository contributor')).toBeInTheDocument();
    expect(within(person).getByText('Universidad de Sevilla')).toBeInTheDocument();
    const profiles = within(
      within(person).getByRole('navigation', { name: 'Francisco Javier Cavero López profiles' })
    );
    expect(profiles.getByRole('link', { name: 'ORCID' })).toHaveAttribute(
      'href',
      'https://orcid.org/0009-0004-2453-8814'
    );
    expect(profiles.getByRole('link', { name: 'GitHub' })).toHaveAttribute('target', '_blank');
    expect(profiles.getByRole('link', { name: 'Google Scholar' })).toBeInTheDocument();
    expect(profiles.getByRole('link', { name: 'Research profile' })).toBeInTheDocument();
    expect(
      screen.getByRole('article', { name: 'José Antonio Parejo Maestre' })
    ).toBeInTheDocument();
    expect(screen.getByText('Contribution is the source of truth.')).toBeInTheDocument();
    expect(screen.queryByText(/\[/)).not.toBeInTheDocument();
  });

  it('says the team is pending review when no entry has been reviewed', () => {
    renderModule(<TeamPage team={[]} />, { user: null, entry: '/team' });

    expect(screen.getByText('Pending editorial review')).toBeInTheDocument();
    expect(screen.getByText('Entries for team appear once they’re reviewed.')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
});
