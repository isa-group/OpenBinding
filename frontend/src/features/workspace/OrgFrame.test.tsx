import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../api/client';
import { classifyAuthError } from './errors';
import { MembersOnlyGate, OrgFrame, OrgGate, OrgSkeleton } from './OrgFrame';
import { org, project } from './testKit';

const isa = org('isa-demo', { name: 'ISA Demo Group' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });

const inRouter = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);
const crumbs = () => within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('listitem').map((item) => item.textContent?.replace('/', '').trim());

describe('OrgFrame', () => {
  it('frames a screen of the organization: its crumb, no project tabs, one live content column', () => {
    inRouter(<OrgFrame organization={isa} trail={[{ label: 'Workbench' }]}><p>content</p></OrgFrame>);

    expect(crumbs()).toEqual(['Home', 'ISA Demo Group', 'Workbench']);
    expect(screen.getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute('href', '/app/isa-demo');
    expect(screen.queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.getByText('content').parentElement).toHaveAttribute('aria-live', 'polite');
  });

  it('frames a screen inside a project with the project crumb and tabs, the current one marked', () => {
    inRouter(<OrgFrame organization={isa} project={qos} section="cases" trail={[{ label: 'Workbench' }]} width="lg" bodyClassName="x-body"><p>content</p></OrgFrame>);

    expect(crumbs()).toEqual(['Home', 'ISA Demo Group', 'QoS Benchmarks', 'Workbench']);
    expect(screen.getByRole('link', { name: 'QoS Benchmarks' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks');
    expect(screen.getByRole('link', { name: 'Problems' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('content').parentElement).toHaveClass('proj-body', 'x-body', 'is-lg');
  });

  it('leaves the last crumb unlinked when it is the organization or the project itself', () => {
    const { unmount } = inRouter(<OrgFrame organization={isa}><p>content</p></OrgFrame>);
    expect(screen.queryByRole('link', { name: 'ISA Demo Group' })).not.toBeInTheDocument();
    unmount();

    inRouter(<OrgFrame organization={isa} project={qos} section="overview"><p>content</p></OrgFrame>);
    expect(screen.getByRole('link', { name: 'ISA Demo Group' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'QoS Benchmarks' })).not.toBeInTheDocument();
  });
});

describe('OrgSkeleton and the gates', () => {
  it('says what is loading', () => {
    inRouter(<OrgSkeleton label="Loading project…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading project…');
  });

  it('reads a missing project and a private one the same, and an organization the neutral way', () => {
    const { unmount } = inRouter(<OrgGate failure={null} />);
    expect(screen.getByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    unmount();

    inRouter(<OrgGate failure={null} subject="organization" />);
    expect(screen.getByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
    expect(screen.getByText(/We show the same message either way/)).toBeInTheDocument();
  });

  it('names the subject that could not be loaded, and the role that does not reach it', () => {
    const { unmount } = inRouter(<OrgGate failure={classifyAuthError(new HttpError(503, 'down'))} subject="organization" />);
    expect(screen.getByRole('heading', { name: /^The organization couldn’t be loaded/ })).toBeInTheDocument();
    unmount();

    inRouter(<OrgGate failure={classifyAuthError(new HttpError(403, 'no'))} organizationName="ISA Demo Group" />);
    expect(screen.getByRole('heading', { name: /^Your role doesn’t reach this/ })).toBeInTheDocument();
    expect(screen.getByText(/This needs a higher role in ISA Demo Group/)).toBeInTheDocument();
  });

  it('tells a visitor that a part of the project is for members, with the way back', () => {
    inRouter(<MembersOnlyGate root="/app/isa-demo/qos-benchmarks" />);
    expect(screen.getByRole('heading', { name: 'Members only' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the project' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks');
  });
});
