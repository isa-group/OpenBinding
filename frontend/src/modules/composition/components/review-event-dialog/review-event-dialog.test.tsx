import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompositionView, UpstreamEventDetail } from '../../../core/api/types';
import valuesChanged from '../../../../test/fixtures/core/upstream.tomatometer.event.values-changed.json';
import reviewed from '../../../../test/fixtures/core/upstream.tomatometer.event.reviewed.json';
import resolved from '../../../../test/fixtures/core/zproposals.upstream-event.resolved.json';
import { fakeGateway, renderModule } from '../../../../test/moduleKit';
import UpstreamEventDetailView from '../upstream-event-detail';
import ReviewEventDialog from '.';

vi.mock('../../../core/utils/sphere/snapshotYaml', () => ({
  snapshotYamlHref: (_org: string, id: string) => id,
  snapshotYaml: async () => 'syntaxVersion: "3.1"\n',
}));

const EVENTS = '/v1/organizations/fixtures/compositions/tomatometer/upstream-events';
const event = valuesChanged as unknown as UpstreamEventDetail;

const composition = {
  id: 'c-1',
  slug: 'tomatometer',
  name: 'TomatoMeter',
  archived: false,
  organization: { id: 'org-fixtures', slug: 'fixtures', name: 'Fixtures' },
} as CompositionView;

function dialog(answer: unknown) {
  const onChanged = vi.fn();
  const gateway = fakeGateway({ [`POST ${EVENTS}/${event.id}/review`]: answer as never });
  renderModule(
    <ReviewEventDialog
      org="fixtures"
      composition="tomatometer"
      event={event}
      etag={'"e-1"'}
      onClose={() => {}}
      onChanged={onChanged}
    />,
    { gateway }
  );
  return { onChanged, gateway };
}

describe('marking an upstream event reviewed', () => {
  it('sends the note with the event’s revision, counts the characters and says it is done', async () => {
    const { onChanged, gateway } = dialog({
      body: { ...valuesChanged, state: 'reviewed' },
      headers: { ETag: '"e-2"' },
    });
    const box = screen.getByRole('dialog', { name: 'Mark reviewed' });
    fireEvent.change(within(box).getByRole('textbox', { name: 'Note' }), {
      target: { value: 'Seen; re-solving' },
    });
    expect(box).toHaveTextContent('16 of 1000 characters');
    fireEvent.click(within(box).getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [, init] = gateway.mock.calls.find(([path]) => String(path).endsWith('/review'))!;
    expect(JSON.parse(init.body)).toEqual({ note: 'Seen; re-solving' });
    expect(init.headers['If-Match']).toBe('"e-1"');
    expect(await screen.findByText('brevo 2026-10 → 2026-11 marked reviewed.')).toBeInTheDocument();
  });

  it('says the event changed on a 412, and offers to read it again', async () => {
    const { onChanged } = dialog({
      status: 412,
      body: { detail: 'Precondition failed', code: 'precondition_failed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This event changed; read it again.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Read it again' }));
    expect(onChanged).toHaveBeenCalled();
  });

  it('says it was already reviewed on a 409, and reads it again', async () => {
    const { onChanged } = dialog({
      status: 409,
      body: { detail: 'The event was already reviewed.', code: 'event_not_reviewable' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText('Already reviewed.')).toBeInTheDocument();
  });
});

describe('who may mark an event reviewed', () => {
  const detail = (body: unknown, role: 'VIEWER' | 'MEMBER') =>
    renderModule(
      <UpstreamEventDetailView
        org="fixtures"
        composition={composition}
        versions={[]}
        eventId={(body as { id: string }).id}
        role={role}
        backTo="/operation"
      />,
      {
        gateway: fakeGateway({
          [`GET ${EVENTS}/${(body as { id: string }).id}`]: { body, headers: { ETag: '"e-1"' } },
        }),
      }
    );

  it('offers it to a MEMBER on an open event, and opens the dialog', async () => {
    detail(valuesChanged, 'MEMBER');
    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
    expect(screen.getByRole('dialog', { name: 'Mark reviewed' })).toBeInTheDocument();
  });

  it('never offers it to a VIEWER, on a reviewed or a resolved event, and never offers a resolve', async () => {
    const viewer = detail(valuesChanged, 'VIEWER');
    await screen.findByRole('heading', { level: 2, name: 'brevo' });
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
    viewer.unmount();
    const member = detail(reviewed, 'MEMBER');
    await screen.findByRole('heading', { level: 2, name: 'brevo' });
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
    member.unmount();
    detail(resolved, 'MEMBER');
    await screen.findByRole('heading', { level: 2 });
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
    expect(screen.queryByRole('button', { name: /resolve/i })).toBeNull();
  });
});
