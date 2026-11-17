import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderModule } from '../../../../test/moduleKit';
import ContributionsPage from '.';

describe('ContributionsPage', () => {
  it('opens a track in a dialog that traps focus, closes on Escape and returns focus', () => {
    renderModule(<ContributionsPage />, { user: null, entry: '/contributions' });
    const track = screen.getByRole('button', { name: /Engine reproducibility benchmark/ });
    expect(track).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    track.focus();
    fireEvent.click(track);

    const dialog = screen.getByRole('dialog', { name: 'Engine reproducibility benchmark' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(
      within(dialog).getByText(/Build comparative studies that measure Pareto quality/)
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('heading', { name: 'Start from a reproducible question' })
    ).toBeInTheDocument();
    expect(within(dialog).getByText('TFG · Research')).toBeInTheDocument();
    expect(within(dialog).getByText('Engines')).toBeInTheDocument();
    expect(within(dialog).queryByText('Supervisor/s:')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Discuss this on GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/isa-group/OpenBinding/issues'
    );

    fireEvent.keyDown(dialog, { key: 'Tab' });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(track).toHaveFocus();
  });

  it('renders the description as markdown, and names the supervisor when the repository does', () => {
    renderModule(
      <ContributionsPage
        tracks={[
          {
            title: 'A thesis',
            level: 'TFM',
            tags: ['BIM'],
            description: 'Do **it** with [care](https://example.org).',
            supervisor: 'Dr. Example',
          },
        ]}
      />,
      { user: null, entry: '/contributions' }
    );

    const card = screen.getByRole('button', { name: /A thesis/ });
    expect(within(card).getByText('it').tagName).toBe('STRONG');
    expect(card).toHaveTextContent('Supervisor/s: Dr. Example');

    fireEvent.click(card);
    const dialog = screen.getByRole('dialog', { name: 'A thesis' });
    expect(within(dialog).getByText('Supervisor/s:')).toBeInTheDocument();
    expect(within(dialog).getByText('Dr. Example')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'care' })).toHaveAttribute('target', '_blank');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('invites a proposal through the issue tracker, and says when no track is reviewed', () => {
    const { unmount } = renderModule(<ContributionsPage />, {
      user: null,
      entry: '/contributions',
    });
    expect(screen.getByRole('link', { name: /Discuss an idea/ })).toHaveAttribute(
      'href',
      'https://github.com/isa-group/OpenBinding/issues'
    );
    unmount();

    renderModule(<ContributionsPage tracks={[]} />, { user: null, entry: '/contributions' });
    expect(
      screen.getByText('Entries for contributions appear once they’re reviewed.')
    ).toBeInTheDocument();
  });
});
