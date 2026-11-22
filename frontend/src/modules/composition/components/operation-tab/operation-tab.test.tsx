import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CompositionView } from '../../../core/api/types';
import environments from '../../../../test/fixtures/core/tomatometer.environments.json';
import production from '../../../../test/fixtures/core/tomatometer.environment.production.json';
import events from '../../../../test/fixtures/core/upstream.tomatometer.events.json';
import valuesChanged from '../../../../test/fixtures/core/upstream.tomatometer.event.values-changed.json';
import offeringChanged from '../../../../test/fixtures/core/upstream.tomatometer.event.offering-changed.json';
import productionCounting from '../../../../test/fixtures/core/upstream.tomatometer.environment.production.json';
import { fakeGateway, renderModule } from '../../../../test/moduleKit';
import OperationTab from '.';

const ROOT = '/v1/organizations/isa-demo/compositions/tomatometer/environments';
const EVENTS = '/v1/organizations/isa-demo/compositions/tomatometer/upstream-events';

const composition = {
  id: 'c-1',
  slug: 'tomatometer',
  name: 'TomatoMeter',
  archived: false,
  organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' },
} as CompositionView;

const render = (role: 'VIEWER' | 'MEMBER' | 'ADMIN', routes = {}, entry = '/') =>
  renderModule(
    <OperationTab
      org="isa-demo"
      composition={composition}
      versions={[]}
      role={role}
      onAdopt={() => {}}
    />,
    {
      entry,
      gateway: fakeGateway({
        [`GET ${ROOT}`]: { body: environments },
        [`GET ${EVENTS}`]: { body: events },
        ...routes,
      }),
    }
  );

describe('the Operation tab', () => {
  it('lists the environments as cards for every member, with what applications read', async () => {
    render('VIEWER');
    expect(screen.getByRole('heading', { level: 2, name: 'Environments' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'What your applications read. It changes only when someone adopts a version.'
      )
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('article', { name: 'Environment Production' })
    ).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /Environment Staging/i })).toBeInTheDocument();
    // A VIEWER reads: no New environment, no Adopt, no kebab.
    expect(screen.queryByRole('button', { name: 'New environment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adopt…' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });

  it('lets a MEMBER adopt where members adopt, and only there', async () => {
    render('MEMBER');
    const staging = await screen.findByRole('article', { name: /Environment Staging/i });
    expect(within(staging).getByRole('button', { name: 'Adopt…' })).toBeInTheDocument();
    const production = screen.getByRole('article', { name: 'Environment Production' });
    expect(within(production).queryByRole('button', { name: 'Adopt…' })).toBeNull();
  });

  it('gives an ADMIN New environment, edit and delete; the form takes focus and creates one', async () => {
    const created = { ...production, id: 'e-new', slug: 'canary', name: 'Canary', inEffect: null };
    render('ADMIN', {
      [`POST ${ROOT}`]: ({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ slug: 'canary', name: 'Canary', adoptRole: 'ADMIN' });
        return { status: 201, body: created, headers: { ETag: '"1"' } };
      },
      'GET /v1/organizations/isa-demo/members': { body: [] },
    });
    await screen.findByRole('article', { name: 'Environment Production' });
    expect(
      within(screen.getByRole('article', { name: 'Environment Production' })).getByRole('button', {
        name: 'Adopt…',
      })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New environment' }));
    const dialog = await screen.findByRole('dialog', { name: 'New environment' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.change(name, { target: { value: 'Canary' } });
    expect(within(dialog).getByRole('textbox', { name: 'Slug' })).toHaveValue('canary');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    expect(await screen.findByText('Environment “Canary” created.')).toBeInTheDocument();
  });

  it('draws the empty state when there is no environment', async () => {
    render('ADMIN', { [`GET ${ROOT}`]: { body: { environments: [] } } });
    expect(await screen.findByText('No environments yet')).toBeInTheDocument();
    expect(
      screen.getByText('Create one for each place an application runs, then adopt a version in it.')
    ).toBeInTheDocument();
  });

  it('opens the environment the address names, with its details', async () => {
    render(
      'VIEWER',
      { [`GET ${ROOT}/production`]: { body: production, headers: { ETag: '"7"' } } },
      '/?environment=production'
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Production' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All environments/ })).toBeInTheDocument();
    expect(screen.getByText('Expected users').nextSibling).toHaveTextContent('1,000');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('lists in an environment every open change it counts: its version’s and the offering’s', async () => {
    const asked: string[] = [];
    render(
      'VIEWER',
      {
        [`GET ${ROOT}/production`]: {
          body: { ...productionCounting, upstream: { ...productionCounting.upstream, open: 2 } },
          headers: { ETag: '"7"' },
        },
        [`GET ${EVENTS}`]: ({ path }: { path: string }) => {
          asked.push(path);
          const query = new URLSearchParams(path.split('?')[1] ?? '');
          const shown =
            query.get('subject') === 'offering'
              ? [offeringChanged]
              : query.get('subject') === 'binding'
                ? [valuesChanged]
                : [valuesChanged, offeringChanged];
          return { body: { ...events, events: shown } };
        },
      },
      '/?environment=production'
    );
    await screen.findByRole('heading', { level: 2, name: 'Production' });
    expect(
      await screen.findByRole('link', { name: 'brevo 2026-10 → 2026-11' })
    ).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /1\.0\.0 → 1\.2\.0/ })).toBeInTheDocument();
    expect(
      asked.some(path => path.includes('subject=offering') && path.includes('state=open'))
    ).toBe(true);
  });

  it('lists the upstream changes under the environments', async () => {
    render('VIEWER');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Upstream changes' })
    ).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'brevo 2026-10 → 2026-11' })).toHaveAttribute(
      'href',
      `/compositions/isa-demo/tomatometer/operation?event=${valuesChanged.id}`
    );
  });

  it('opens the event the address names in place, with a way back to the tab', async () => {
    render(
      'VIEWER',
      {
        [`GET ${EVENTS}/${valuesChanged.id}`]: { body: valuesChanged, headers: { ETag: '"e"' } },
      },
      `/?event=${valuesChanged.id}`
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'brevo' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All upstream changes/ })).toHaveAttribute(
      'href',
      '/compositions/isa-demo/tomatometer/operation'
    );
    expect(screen.queryByRole('heading', { level: 2, name: 'Environments' })).toBeNull();
  });
});
