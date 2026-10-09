import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { EDITION, FROZEN, publicationOf } from './fixtures';
import { ProjPublications } from './ProjPublications';

const platform = vi.hoisted(() => ({ project: vi.fn(), publicProjects: vi.fn(), reports: vi.fn(), publications: vi.fn(), deletePublication: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const member = org('team-lab', { name: 'Team Lab', effective_role: 'MEMBER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const ROOT = '/app/isa-demo/qos-benchmarks';

const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });

function renderPublications(slug = 'isa-demo') {
  return renderProjectScreen(<ProjPublications />, { path: '/app/:org/:project/publications', url: `/app/${slug}/qos-benchmarks/publications`, organizations: [group, viewing, member] });
}

describe('Publications of a project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.reports.mockResolvedValue([FROZEN]);
    platform.publications.mockResolvedValue([publicationOf(FROZEN)]);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  it('shows each public edition with how to cite it, its public link and the way to verify it', async () => {
    renderPublications();

    expect(await screen.findByRole('heading', { level: 1, name: 'Publications' })).toBeInTheDocument();
    expect(screen.getByText(/Report editions made public from QoS Benchmarks\. Withdrawing hides one from listings but keeps every link and fingerprint working\./)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Comparativa de engines en checkout (sintética)' })).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('checkout-comparativa · published Sep 25, 2026 · sha256-eeee…eeee')).toBeInTheDocument();
    expect(screen.getByText('Lucía Vega (2026). Comparativa de engines en checkout (sintética). ISA Demo Group / QoS Benchmarks.')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`/resolve/report/${EDITION}$`))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open public verification' })).toHaveAttribute('href', `/resolve/report/${EDITION}`);
    expect(screen.getByRole('link', { name: 'Open the report' })).toHaveAttribute('href', `${ROOT}/reports/engines-vs-seeds-informe`);
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Reports' })).toHaveAttribute('aria-current', 'page');

    fireEvent.click(screen.getByRole('button', { name: 'Copy for reference manager' }));
    expect(await screen.findByRole('button', { name: 'Copied for reference manager' })).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/^@misc\{lucavega2026checkoutcomparativa,/));
  });

  it('withdraws a publication after confirming, and then marks it as still reachable by link', async () => {
    platform.publications.mockResolvedValueOnce([publicationOf(FROZEN)]).mockResolvedValue([publicationOf(FROZEN, { withdrawn: true })]);
    platform.deletePublication.mockResolvedValue(undefined);
    renderPublications();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));

    const dialog = await screen.findByRole('dialog', { name: 'Withdraw checkout-comparativa?' });
    expect(within(dialog).getByText(/Its link, citation and fingerprint keep working/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));

    expect(await screen.findByText('Withdrawn. It’s no longer listed in Explore, but its link, citation and fingerprint still work.')).toBeInTheDocument();
    expect(platform.deletePublication).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'checkout-comparativa');
    expect(await screen.findByText('Withdrawn · still reachable by link')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
    // Its link and verification keep working.
    expect(screen.getByRole('link', { name: 'Open public verification' })).toBeInTheDocument();
  });

  it('reports a refusal to withdraw inside the dialog (403)', async () => {
    platform.deletePublication.mockRejectedValue(refusal(403, 'forbidden'));
    renderPublications();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));

    const dialog = await screen.findByRole('dialog', { name: 'Withdraw checkout-comparativa?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));

    expect(await within(dialog).findByText('Your role doesn’t reach this (403 · forbidden)')).toBeInTheDocument();
    expect(within(dialog).getByText(/needs ADMIN in the organization/)).toBeInTheDocument();
  });

  it('lets members and viewers read, and says withdrawing needs an admin', async () => {
    const view = renderPublications('team-lab');
    expect(await screen.findByText('Withdrawing needs ADMIN.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
    view.unmount();

    renderPublications('read-lab');
    expect(await screen.findByText('Withdrawing needs ADMIN.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open public verification' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
  });

  it('does not claim a fingerprint for an edition the report has moved past', async () => {
    platform.publications.mockResolvedValue([publicationOf(FROZEN, { version_id: 'an-earlier-edition' })]);
    renderPublications();

    expect(await screen.findByText('checkout-comparativa · published Sep 25, 2026')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open public verification' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the report' })).toBeInTheDocument();
  });

  it('says nothing is published yet, and where to publish from', async () => {
    platform.publications.mockResolvedValue([]);
    renderPublications();

    expect(await screen.findByText('Nothing published yet')).toBeInTheDocument();
    expect(screen.getByText('Nothing published from this project yet. Publish a frozen report edition from its page.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the reports' })).toHaveAttribute('href', `${ROOT}/reports`);
  });

  it('keeps a failure apart from an empty list: 404, 403 and 503 with Retry', async () => {
    platform.publications.mockRejectedValueOnce(refusal(404, 'not_found'));
    const first = renderPublications();
    expect(await screen.findByText(/Publications couldn’t be found \(404 · not_found\)/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing published yet')).not.toBeInTheDocument();
    first.unmount();

    platform.publications.mockRejectedValueOnce(refusal(403, 'api_key_boundary'));
    const second = renderPublications();
    expect(await screen.findByText(/This API key can’t read publications \(403 · api_key_boundary\)/)).toBeInTheDocument();
    second.unmount();

    platform.publications.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderPublications();
    const message = await screen.findByText(/Publications couldn’t be loaded \(503 · unavailable\)/);
    fireEvent.click(within(message.closest('.ui-notice') as HTMLElement).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Comparativa de engines en checkout (sintética)' })).toBeInTheDocument();
  });
});
