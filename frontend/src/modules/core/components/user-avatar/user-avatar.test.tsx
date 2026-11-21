import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import UserAvatar from '.';
import { avatarInitials } from './avatar-values';

// The descriptors SCORETech Identity shares (`ApplicationUserClaims.java` at 215dffe), as the gateway serves them: named
// colours already turned into hex (graphite #212529, paper #ffffff), a preset without colours.
const kind = (container: HTMLElement) =>
  container.querySelector('[data-avatar-kind]')?.getAttribute('data-avatar-kind');

describe('UserAvatar', () => {
  it('draws the initials of the display name in the descriptor colours', () => {
    const { container } = render(
      <UserAvatar
        username="walk.member"
        displayName="Walk Member"
        avatar={{ kind: 'initials', backgroundColor: '#212529', foregroundColor: '#ffffff' }}
      />
    );
    expect(kind(container)).toBe('initials');
    expect(screen.getByText('WM')).toHaveStyle({
      backgroundColor: 'rgb(33, 37, 41)',
      color: 'rgb(255, 255, 255)',
    });
  });

  it('draws an icon descriptor with its glyph, not the initials', () => {
    const { container } = render(
      <UserAvatar
        username="walk.member"
        displayName="Walk Member"
        avatar={{
          kind: 'icon',
          assetId: 'leaf',
          backgroundColor: '#212529',
          foregroundColor: '#ffffff',
        }}
      />
    );
    expect(kind(container)).toBe('icon');
    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.queryByText('WM')).not.toBeInTheDocument();
  });

  it('draws SPHERE artwork in the foreground colour', () => {
    const { container } = render(
      <UserAvatar
        username="walk.member"
        avatar={{
          kind: 'icon',
          assetId: 'avatar-7',
          backgroundColor: '#be1d37',
          foregroundColor: '#ffd900',
        }}
      />
    );
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(decodeURIComponent(image?.getAttribute('src') ?? '')).toContain("fill='#ffd900'");
  });

  it('draws a preset in Identity default colours', () => {
    const { container } = render(
      <UserAvatar username="walk.member" avatar={{ kind: 'preset', assetId: 'owl' }} />
    );
    expect(kind(container)).toBe('preset');
    expect(container.querySelector('[data-avatar-kind]')).toHaveStyle({
      backgroundColor: 'rgb(190, 29, 55)',
    });
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('draws the initial of the username without a descriptor', () => {
    const { container } = render(<UserAvatar username="lucia" displayName="Lucía Vega" />);
    expect(kind(container)).toBeUndefined();
    expect(screen.getByText('L')).toBeInTheDocument();
  });

  it('takes Identity initials: two words, upper-cased, "?" for none', () => {
    expect(avatarInitials('ana maría pérez')).toBe('AM');
    expect(avatarInitials('  ')).toBe('?');
  });
});
