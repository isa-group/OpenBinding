import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../api/client';
import { classifyAuthError } from '../../modules/core/api/errors';
import { OrgFrame, OrgGate, OrgSkeleton } from './OrgFrame';
import { org } from './testKit';

const isa = org('isa-demo', { name: 'ISA Demo Group' });

const inRouter = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);
const crumbs = () =>
  within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
    .getAllByRole('listitem')
    .map(item => item.textContent?.replace('/', '').trim());

describe('OrgFrame', () => {
  it('frames a screen of the organization: its crumb, no tabs, one live content column', () => {
    inRouter(
      <OrgFrame organization={isa} trail={[{ label: 'Workbench' }]}>
        <p>content</p>
      </OrgFrame>
    );

    expect(crumbs()).toEqual(['Home', 'ISA Demo Group', 'Workbench']);
    expect(screen.getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute(
      'href',
      '/orgs/isa-demo'
    );
    expect(screen.queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.getByText('content').parentElement).toHaveAttribute('aria-live', 'polite');
  });

  it('sizes and names the content column', () => {
    inRouter(
      <OrgFrame organization={isa} trail={[{ label: 'Runs' }]} width="lg" bodyClassName="x-body">
        <p>content</p>
      </OrgFrame>
    );

    expect(screen.getByText('content').parentElement).toHaveClass('proj-body', 'x-body', 'is-lg');
  });

  it('leaves the last crumb unlinked when it is the organization itself', () => {
    inRouter(
      <OrgFrame organization={isa}>
        <p>content</p>
      </OrgFrame>
    );
    expect(crumbs()).toEqual(['Home', 'ISA Demo Group']);
    expect(screen.queryByRole('link', { name: 'ISA Demo Group' })).not.toBeInTheDocument();
  });
});

describe('OrgSkeleton and the gates', () => {
  it('says what is loading', () => {
    inRouter(<OrgSkeleton label="Loading runs…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading runs…');
  });

  it('reads a missing organization and one the account is not in the same, the neutral way', () => {
    inRouter(<OrgGate failure={null} />);
    expect(screen.getByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
    expect(screen.getByText(/We show the same message either way/)).toBeInTheDocument();
  });

  it('says the organization could not be loaded, and names the role that does not reach it', () => {
    const { unmount } = inRouter(
      <OrgGate failure={classifyAuthError(new HttpError(503, 'down'))} />
    );
    expect(
      screen.getByRole('heading', { name: /^The organization couldn’t be loaded/ })
    ).toBeInTheDocument();
    unmount();

    inRouter(
      <OrgGate
        failure={classifyAuthError(new HttpError(403, 'no'))}
        organizationName="ISA Demo Group"
      />
    );
    expect(
      screen.getByRole('heading', { name: /^Your role doesn’t reach this/ })
    ).toBeInTheDocument();
    expect(screen.getByText(/This needs a higher role in ISA Demo Group/)).toBeInTheDocument();
  });
});
