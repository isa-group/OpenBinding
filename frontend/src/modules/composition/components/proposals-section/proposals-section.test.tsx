import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompositionVersionView, CompositionView } from '../../../core/api/types';
import pending from '../../../../test/fixtures/core/zproposals.pending.json';
import completed from '../../../../test/fixtures/core/zproposals.completed.json';
import stale from '../../../../test/fixtures/core/zproposals.stale.json';
import listed from '../../../../test/fixtures/core/zproposals.list.json';
import { fakeGateway, renderModule } from '../../../../test/moduleKit';
import ProposalsSection from '.';

const ORG = '/v1/organizations/fixtures';
const LIST = `${ORG}/compositions/tomatometer/proposals`;

const composition = {
  id: 'c-1',
  slug: 'tomatometer',
  name: 'TomatoMeter',
  archived: false,
  organization: { id: 'org-fixtures', slug: 'fixtures', name: 'Fixtures' },
} as CompositionView;

const versions = [
  { id: '00000000-0000-4000-8000-000000000038', label: '1.1.0' },
  { id: '00000000-0000-4000-8000-000000000036', label: '1.0.0' },
] as CompositionVersionView[];

// The caller's pending proposal (the B5 fixture), then the decided ones of the composition's list.
const list = {
  proposals: [
    pending,
    ...listed.proposals.filter(item => item.id !== pending.id && item.status !== 'pending'),
  ],
};

const environments = [
  { id: '00000000-0000-4000-8000-000000000040', slug: 'production', name: 'Production' },
];

function draw(routes: Record<string, unknown>) {
  const gateway = fakeGateway({
    [`GET ${LIST}`]: { body: list },
    [`GET ${ORG}/proposals/${pending.id}`]: { body: pending },
    ...(routes as Parameters<typeof fakeGateway>[0]),
  });
  renderModule(
    <ProposalsSection
      org="fixtures"
      composition={composition}
      versions={versions}
      environments={environments}
    />,
    { gateway }
  );
  return gateway;
}

describe('the proposals of the Operation tab', () => {
  it('puts the caller’s pending proposal on top with its bases, and the decided ones collapsed', async () => {
    draw({});
    const top = await screen.findByRole('group', { name: `Proposal: ${pending.summary}` });
    expect(top).toHaveTextContent('Waiting for your confirmation');
    expect(top).toHaveTextContent(
      'Built on 1.1.0 as the latest version, and on the exact document shown.'
    );
    expect(top).toHaveTextContent('Production as it was when proposed, with 1.0.0 in effect.');
    expect(screen.getByText('Recent proposals (3)')).toBeInTheDocument();
  });

  it('marks the proposal applying at once, then shows the gateway’s final proposal', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const base = fakeGateway({
      [`GET ${LIST}`]: { body: list },
      [`GET ${ORG}/proposals/${pending.id}`]: { body: pending },
    });
    const gateway = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/confirm')) {
        await gate;
        return new Response(JSON.stringify(completed), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return base(path, init);
    });
    renderModule(
      <ProposalsSection
        org="fixtures"
        composition={composition}
        versions={versions}
        environments={environments}
      />,
      { gateway }
    );
    const top = await screen.findByRole('group', { name: `Proposal: ${pending.summary}` });
    fireEvent.click(within(top).getByRole('button', { name: 'Confirm and apply' }));
    expect(await within(top).findByText('Applying…')).toBeInTheDocument();
    expect(top).toHaveTextContent('Step 1 of 2');
    release();
    expect(await within(top).findByText('Applied')).toBeInTheDocument();
    expect(top).toHaveTextContent('2 of 2 steps done');
  });

  it('says an out-of-date proposal changed nothing, and reads it again', async () => {
    let reads = 0;
    draw({
      [`POST ${ORG}/proposals/${pending.id}/confirm`]: { status: 409, body: stale },
      [`GET ${ORG}/proposals/${pending.id}`]: () => {
        reads += 1;
        return { body: reads > 1 ? { ...pending, status: 'stale' } : pending };
      },
    });
    const top = await screen.findByRole('group', { name: `Proposal: ${pending.summary}` });
    await waitFor(() => expect(reads).toBe(1));
    fireEvent.click(within(top).getByRole('button', { name: 'Confirm and apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This proposal is out of date: production changed since it was made. Nothing was changed.'
    );
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });

  it('keeps a proposal waiting when the composition is busy', async () => {
    draw({
      [`POST ${ORG}/proposals/${pending.id}/confirm`]: {
        status: 429,
        body: { detail: 'Busy.', code: 'composition_busy' },
      },
    });
    const top = await screen.findByRole('group', { name: `Proposal: ${pending.summary}` });
    fireEvent.click(within(top).getByRole('button', { name: 'Confirm and apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The composition is busy with another change. Nothing was changed, and the proposal still waits'
    );
    expect(top).toHaveTextContent('Waiting for your confirmation');
  });

  it('cancels the caller’s proposal', async () => {
    draw({
      [`DELETE ${ORG}/proposals/${pending.id}`]: { body: { ...pending, status: 'cancelled' } },
    });
    const top = await screen.findByRole('group', { name: `Proposal: ${pending.summary}` });
    fireEvent.click(within(top).getByRole('button', { name: 'Cancel' }));
    expect(await within(top).findByText('Cancelled')).toBeInTheDocument();
  });

  it('is left out when the composition has no proposal', async () => {
    const gateway = draw({ [`GET ${LIST}`]: { body: { proposals: [] } } });
    await waitFor(() => expect(gateway).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Proposals' })).toBeNull();
  });
});
