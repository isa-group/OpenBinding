import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CompositionView } from '../../../core/api/types';
import list from '../../../../test/fixtures/core/upstream.tomatometer.events.json';
import two from '../../../../test/fixtures/core/upstream.tomatometer.events.two.json';
import offering from '../../../../test/fixtures/core/upstream.tomatometer.event.offering-changed.json';
import { fakeGateway, renderModule } from '../../../../test/moduleKit';
import UpstreamEventsSection from '.';

const EVENTS = '/v1/organizations/fixtures/compositions/tomatometer/upstream-events';

const composition = {
  id: 'c-1',
  slug: 'tomatometer',
  name: 'TomatoMeter',
  archived: false,
  organization: { id: 'org-fixtures', slug: 'fixtures', name: 'Fixtures' },
} as CompositionView;

const draw = (body: unknown) =>
  renderModule(<UpstreamEventsSection org="fixtures" composition={composition} />, {
    gateway: fakeGateway({ [`GET ${EVENTS}`]: { body } }),
  });

describe('the upstream changes of the Operation tab', () => {
  it('says what it watches, and lists the events as rows that open in place', async () => {
    draw(list);
    const rows = await screen.findByRole('list', { name: 'Upstream events' });
    expect(screen.getByLabelText('Watched pricings')).toHaveTextContent(
      'Watching 4 pricings · last checked'
    );
    const [row] = within(rows).getAllByRole('listitem');
    expect(row).toHaveTextContent('Values changed');
    expect(row).toHaveTextContent('Open');
    expect(row).toHaveTextContent('Version 1.0.0 · dailySummary · in effect in production');
    expect(within(row).getByRole('link', { name: 'brevo 2026-10 → 2026-11' })).toHaveAttribute(
      'href',
      `/compositions/fixtures/tomatometer/operation?event=${list.events[0].id}`
    );
  });

  it('marks the older of two stacked events superseded, and filters by state', async () => {
    draw(two);
    const rows = await screen.findByRole('list', { name: 'Upstream events' });
    expect(within(rows).getAllByRole('listitem')).toHaveLength(2);
    expect(rows).toHaveTextContent('superseded by a newer upstream version');
    fireEvent.click(screen.getByRole('button', { name: /^Reviewed/ }));
    expect(within(rows).getAllByRole('listitem')).toHaveLength(1);
    expect(rows).toHaveTextContent('Rebinding recommended');
    expect(screen.getByRole('button', { name: /^No impact/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('draws the empty state when nothing changed upstream', async () => {
    draw({ ...list, events: [], counts: { open: 0, reviewed: 0, resolved: 0, noImpact: 0 } });
    expect(
      await screen.findByText(
        'Nothing changed upstream since these versions were sealed. OpenBinding checks their pricings every few minutes.'
      )
    ).toBeInTheDocument();
  });

  it('says why a watch is paused', async () => {
    draw({
      ...list,
      watches: [{ ...list.watches[0], status: 'gone' }, ...list.watches.slice(1)],
    });
    expect(await screen.findByLabelText('Watched pricings')).toHaveTextContent(
      'atenea/dropbox is paused: it is no longer readable in SPHERE.'
    );
  });

  it('says an offering event affects the environments, not that its version is in effect there', async () => {
    draw({ ...list, events: [{ ...offering, environments: ['production', 'staging'] }] });
    const rows = await screen.findByRole('list', { name: 'Upstream events' });
    const [row] = within(rows).getAllByRole('listitem');
    expect(row).toHaveTextContent(
      'The offering, against version 1.1.0 · affects production, staging'
    );
    expect(row).not.toHaveTextContent('in effect in');
  });

  it('says when the older changes could not be read, and lets the reader try again', async () => {
    let older = 0;
    renderModule(<UpstreamEventsSection org="fixtures" composition={composition} />, {
      gateway: fakeGateway({
        [`GET ${EVENTS}`]: ({ path }: { path: string }) => {
          if (!path.includes('before=')) return { body: { ...list, nextBefore: 'cursor-1' } };
          older += 1;
          return { status: 503, body: { code: 'unavailable', detail: 'Try later' } };
        },
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Show older changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The older changes couldn’t be read. Try again.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show older changes' }));
    await waitFor(() => expect(older).toBe(2));
  });
});
