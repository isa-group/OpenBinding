import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompositionVersionView, CompositionView } from '../../../core/api/types';
import valuesChanged from '../../../../test/fixtures/core/upstream.tomatometer.event.values-changed.json';
import bindingInvalid from '../../../../test/fixtures/core/upstream.tomatometer.event.binding-invalid.json';
import offering from '../../../../test/fixtures/core/upstream.tomatometer.event.offering-changed.json';
import unavailable from '../../../../test/fixtures/core/upstream.tomatometer.event.unavailable.json';
import withdrawn from '../../../../test/fixtures/core/upstream.tomatometer.event.withdrawn.json';
import reviewed from '../../../../test/fixtures/core/upstream.tomatometer.event.reviewed.json';
import versionsPage from '../../../../test/fixtures/core/upstream.tomatometer.versions.json';
import before from '../../../../test/fixtures/core/upstream.brevo.2026-10.yaml?raw';
import after from '../../../../test/fixtures/core/upstream.brevo.2026-11.yaml?raw';
import { fakeGateway, renderModule } from '../../../../test/moduleKit';
import UpstreamEventDetailView from '.';

vi.mock('../../../core/utils/sphere/snapshotYaml', () => ({
  snapshotYamlHref: (_org: string, id: string) => id,
  snapshotYaml: async (id: string) =>
    id === '00000000-0000-4000-8000-000000000026' ? before : after,
}));

const EVENTS = '/v1/organizations/fixtures/compositions/tomatometer/upstream-events';

const composition = {
  id: 'c-1',
  slug: 'tomatometer',
  name: 'TomatoMeter',
  archived: false,
  organization: { id: 'org-fixtures', slug: 'fixtures', name: 'Fixtures' },
} as CompositionView;

const versions = versionsPage.versions as unknown as CompositionVersionView[];

function open(event: { id: string }, role: 'VIEWER' | 'MEMBER' = 'MEMBER', extra = {}) {
  return renderModule(
    <UpstreamEventDetailView
      org="fixtures"
      composition={composition}
      versions={versions}
      eventId={event.id}
      role={role}
      backTo="/operation"
    />,
    {
      gateway: fakeGateway({
        ...('category' in event
          ? { [`GET ${EVENTS}/${event.id}`]: { body: event, headers: { ETag: '"e-1"' } } }
          : {}),
        ...extra,
      }),
    }
  );
}

describe('an upstream event opened in place', () => {
  it('heads a values-changed event with the pricing, the two versions and where it is in effect', async () => {
    open(valuesChanged);
    expect(await screen.findByRole('heading', { level: 2, name: 'brevo' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2026-10' })).toHaveAttribute(
      'href',
      valuesChanged.old.url
    );
    expect(screen.getByRole('link', { name: '2026-11' })).toHaveAttribute(
      'href',
      valuesChanged.new.url
    );
    expect(screen.getByText('Values changed')).toBeInTheDocument();
    expect(screen.getByText('In effect in production')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Global values' })).toHaveTextContent(
      'subscription 508.99 → 558.99 USD/month, +50.00'
    );
    // The plan is drawn before and after by pricing-renderer (its own element), read only.
    await waitFor(() => expect(document.querySelector('pricing-change-review')).not.toBeNull());
  });

  it('gives a MEMBER the actions on a binding event, and a VIEWER none', async () => {
    const member = open(valuesChanged, 'MEMBER');
    await screen.findByRole('heading', { level: 2, name: 'brevo' });
    expect(screen.getByRole('link', { name: 'Open the configurator' })).toHaveAttribute(
      'href',
      '/compositions/fixtures/tomatometer/configuration?version=1.0.0'
    );
    expect(screen.getByRole('link', { name: 'Update from SPHERE' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/problems\/fixtures\/[^?]+\?sphereStep=pricing&sphereUpdate=1$/)
    );
    expect(screen.getByRole('link', { name: 'Run again' })).toBeInTheDocument();
    member.unmount();
    open(valuesChanged, 'VIEWER');
    await screen.findByRole('heading', { level: 2, name: 'brevo' });
    expect(screen.queryByRole('link', { name: 'Open the configurator' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Update from SPHERE' })).toBeNull();
  });

  it('recommends rebinding when the bound plan was retired', async () => {
    open(bindingInvalid);
    await screen.findByRole('heading', { level: 2, name: 'brevo' });
    expect(screen.getAllByText('Rebinding recommended').length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'Why' })).toHaveTextContent(
      'Plan PROFESSIONAL is no longer offered.'
    );
  });

  it('says a vanished family is no longer readable, with no new side', async () => {
    open(unavailable);
    await screen.findByRole('heading', { level: 2, name: 'Dropbox' });
    expect(screen.getByRole('link', { name: '2021' }).closest('p')).toHaveTextContent(
      '→ no longer readable'
    );
    expect(screen.getByRole('region', { name: 'Why' })).toHaveTextContent(
      'no longer readable in SPHERE (hidden, private or deleted)'
    );
  });

  it('says a withdrawn version is no longer listed', async () => {
    open(withdrawn);
    await screen.findByRole('heading', { level: 2, name: 'Resend' });
    expect(screen.getByRole('region', { name: 'Why' })).toHaveTextContent(
      'the pinned version is no longer listed'
    );
  });

  it('shows an offering event’s margins before and after in each environment, with no resolve wording', async () => {
    open(offering);
    await screen.findByRole('heading', { level: 2, name: 'TomatoMeter' });
    const production = screen.getByRole('region', { name: 'Margins in production' });
    const tables = within(production).getAllByRole('table');
    expect(tables).toHaveLength(2);
    expect(within(tables[0]).getAllByRole('row')[1]).toHaveTextContent('−0.51');
    expect(within(tables[1]).getAllByRole('row')[1]).toHaveTextContent('0.48');
    expect(
      screen.getByText('The offering is not pinned in the document; this event ends when reviewed.')
    ).toBeInTheDocument();
    // Every environment with a version in effect offers the plans, whichever version holds it.
    expect(
      screen.getByText('Affects production: every environment with a version in effect')
    ).toBeInTheDocument();
    expect(screen.queryByText(/^In effect in/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Update from SPHERE' })).toBeNull();
  });

  it('names who reviewed it and their note', async () => {
    open(reviewed);
    await screen.findByRole('heading', { level: 2, name: 'brevo' });
    expect(screen.getByText('Reviewed', { selector: 'dt' }).parentElement).toHaveTextContent(
      reviewed.reviewedBy?.username ?? ''
    );
  });

  it('is the in-place 404 for an event that is missing', async () => {
    open({ id: 'nope' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
