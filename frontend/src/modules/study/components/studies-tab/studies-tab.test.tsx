import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../core/api/http';
import { cellsFixture, runFixture, studyFixture } from '../../../../test/fixtures/studies';
import { addressNow, fakeGateway, renderModule, type Answer } from '../../../../test/moduleKit';
import StudiesTab, { PER_PAGE } from '.';

const platform = vi.hoisted(() => ({ update: vi.fn(), remove: vi.fn() }));
vi.mock('../../api/studiesApi', async () => ({
  ...(await vi.importActual<typeof import('../../api/studiesApi')>('../../api/studiesApi')),
  studiesApi: platform,
}));

const ROOT = '/v1/organizations/isa-demo/studies';
const STUDY = `${ROOT}/engines-vs-seeds`;
const refusal = (status: number, code: string) =>
  Object.assign(new HttpError(status, 'refused'), { code });

function gateway(over: Record<string, Answer> = {}) {
  return fakeGateway({
    [`GET ${ROOT}`]: { body: [studyFixture()], headers: { 'X-Total-Count': '1' } },
    [`GET ${STUDY}/runs`]: { body: [runFixture()] },
    [`GET ${STUDY}/runs/${runFixture().id}/cells`]: { body: cellsFixture() },
    ...over,
  });
}

function renderTab(
  options: {
    role?: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
    entry?: string;
    routes?: Record<string, Answer>;
  } = {}
) {
  return renderModule(
    <StudiesTab
      org={{ slug: 'isa-demo', name: 'ISA Demo Group' }}
      myRole={options.role ?? 'OWNER'}
    />,
    { entry: options.entry ?? '/orgs/isa-demo/studies', gateway: gateway(options.routes) }
  );
}

describe('The Studies tab of an organization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows each study as a card with its formula, its latest run and how that run ended', async () => {
    const { gateway: calls } = renderTab();

    const card = await screen.findByRole('article', { name: 'Engines × seeds' });
    expect(within(card).getByRole('link', { name: 'Engines × seeds' })).toHaveAttribute(
      'href',
      '/studies/isa-demo/engines-vs-seeds'
    );
    expect(within(card).getByText('2 × 2 × 1 × 2 = 8 cells')).toBeInTheDocument();
    expect(await within(card).findByText('Run #1')).toBeInTheDocument();
    expect(
      await within(card).findByRole('img', {
        name: '6 completed, 1 failed, 1 cancelled of 8 cells',
      })
    ).toBeInTheDocument();
    expect(calls).toHaveBeenCalledWith(
      `${ROOT}?include_archived=false&limit=${PER_PAGE}&offset=0`,
      expect.anything()
    );
  });

  it('says a study was never run', async () => {
    renderTab({ routes: { [`GET ${STUDY}/runs`]: { body: [] } } });

    const card = await screen.findByRole('article', { name: 'Engines × seeds' });
    expect(await within(card).findByText('Never run')).toBeInTheDocument();
  });

  it('explains what a study is when there are none, and offers to build one', async () => {
    renderTab({ routes: { [`GET ${ROOT}`]: { body: [], headers: { 'X-Total-Count': '0' } } } });

    expect(await screen.findByText('No studies yet.')).toBeInTheDocument();
    expect(
      screen.getByText(
        '2 problem versions × 2 engines × 2 seeds = 8 runs, all with the same rules. That’s a study.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Build a study' })).toHaveAttribute(
      'href',
      '/studies/new?org=isa-demo'
    );
    expect(screen.getByRole('link', { name: 'New study' })).toHaveAttribute(
      'href',
      '/studies/new?org=isa-demo'
    );
  });

  it('lets a viewer read: no new study, no archive, no delete', async () => {
    renderTab({ role: 'VIEWER' });

    await screen.findByRole('article', { name: 'Engines × seeds' });
    expect(screen.queryByRole('link', { name: 'New study' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Engines × seeds' })
    ).not.toBeInTheDocument();
  });

  it('lets a member create and archive but not delete', async () => {
    platform.update.mockResolvedValue({ value: studyFixture({ archived: true }), etag: null });
    renderTab({ role: 'MEMBER' });

    expect(await screen.findByRole('link', { name: 'New study' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Engines × seeds' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(
      await screen.findByText(/Study “Engines × seeds” archived: it can’t start new runs/)
    ).toBeInTheDocument();
    expect(platform.update).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds', {
      archived: true,
    });
  });

  it('shows the archived studies when asked, in the address', async () => {
    const { gateway: calls } = renderTab({
      routes: {
        [`GET ${ROOT}`]: ({ path }) =>
          path.includes('include_archived=true')
            ? {
                body: [
                  studyFixture(),
                  studyFixture({ id: 'study-old', slug: 'old', name: 'Old study', archived: true }),
                ],
                headers: { 'X-Total-Count': '2' },
              }
            : { body: [studyFixture()], headers: { 'X-Total-Count': '1' } },
        [`GET ${ROOT}/old/runs`]: { body: [] },
      },
    });

    await screen.findByRole('article', { name: 'Engines × seeds' });
    expect(screen.queryByRole('article', { name: 'Old study' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived studies' }));
    const old = await screen.findByRole('article', { name: 'Old study' });
    expect(within(old).getByText('Archived')).toBeInTheDocument();
    expect(addressNow()).toBe('/orgs/isa-demo/studies?archived=true');
    expect(calls).toHaveBeenCalledWith(
      `${ROOT}?include_archived=true&limit=${PER_PAGE}&offset=0`,
      expect.anything()
    );
  });

  it('pages through the studies the gateway counts', async () => {
    const { gateway: calls } = renderTab({
      routes: { [`GET ${ROOT}`]: { body: [studyFixture()], headers: { 'X-Total-Count': '30' } } },
    });

    await screen.findByRole('article', { name: 'Engines × seeds' });
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() =>
      expect(calls).toHaveBeenCalledWith(
        `${ROOT}?include_archived=false&limit=${PER_PAGE}&offset=${PER_PAGE}`,
        expect.anything()
      )
    );
    expect(addressNow()).toBe('/orgs/isa-demo/studies?page=2');
  });

  it('archives instead when a study with runs is deleted, because runs are history', async () => {
    platform.remove.mockRejectedValue(refusal(409, 'study_history_retained'));
    platform.update.mockResolvedValue({ value: studyFixture({ archived: true }), etag: null });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Engines × seeds' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete study' }));

    expect(
      await screen.findByText(
        'Engines × seeds has runs, so it was archived instead of deleted. Its runs and results stay intact.'
      )
    ).toBeInTheDocument();
    expect(platform.remove).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds');
    expect(platform.update).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds', {
      archived: true,
    });
  });

  it('says why a delete was refused', async () => {
    platform.remove.mockRejectedValue(refusal(403, 'forbidden'));
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Engines × seeds' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete study' }));

    expect(
      await screen.findByText(/This account or key can’t do that \(403 · forbidden\)/)
    ).toBeInTheDocument();
    expect(platform.update).not.toHaveBeenCalled();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    let calls = 0;
    renderTab({
      routes: {
        [`GET ${ROOT}`]: () =>
          (calls += 1) === 1
            ? { status: 503, body: { code: 'unavailable', detail: 'down' } }
            : { body: [studyFixture()], headers: { 'X-Total-Count': '1' } },
      },
    });

    expect(await screen.findByText(/The studies could not be loaded\./)).toBeInTheDocument();
    expect(screen.queryByText('No studies yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('article', { name: 'Engines × seeds' })).toBeInTheDocument();
  });
});
