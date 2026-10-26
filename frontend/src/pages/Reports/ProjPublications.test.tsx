import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { EDITION, FROZEN, publicationOf } from '../../test/fixtures/reports';
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
    expect(await screen.findByRole('heading', { level: 2, name: 'Engine comparison at checkout' })).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('checkout-comparison · published Sep 25, 2026 · sha256-eeee…eeee')).toBeInTheDocument();
    expect(screen.getByText('Alex Rivera (2026). Engine comparison at checkout. ISA Demo Group / QoS Benchmarks.')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`/resolve/report/${EDITION}$`))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open public verification' })).toHaveAttribute('href', `/resolve/report/${EDITION}`);
    // [utest->req~frontend-retire-reports-publications-stay~1]
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Publications' })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: 'Publications' })).toHaveAttribute('href', `${ROOT}/publications`);

    fireEvent.click(screen.getByRole('button', { name: 'Copy for reference manager' }));
    expect(await screen.findByRole('button', { name: 'Copied for reference manager' })).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/^@misc\{alexrivera2026checkoutcomparison,/));
  });

  // [utest->req~frontend-retire-reports-publications-stay~1]
  it('leads nowhere to the retired report pages: no Open the report, no Reports crumb, tab or action', async () => {
    renderPublications();

    expect(await screen.findByRole('heading', { level: 2, name: 'Engine comparison at checkout' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open the report' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^(Open the )?reports$/i })).not.toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).queryByRole('link', { name: 'Reports' })).not.toBeInTheDocument();
    expect(within(crumbs).getAllByRole('link').map((link) => link.textContent)).toEqual(['Home', 'ISA Demo Group', 'QoS Benchmarks']);
    expect(within(crumbs).getByText('Publications')).toHaveAttribute('aria-current', 'page');
    const hrefs = Array.from(document.querySelectorAll('a[href]')).map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.filter((href) => /\/reports([/?#]|$)/.test(href))).toEqual([]);
    // Still a publication list: the citation and the public verification stay.
    expect(screen.getByText('Alex Rivera (2026). Engine comparison at checkout. ISA Demo Group / QoS Benchmarks.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open public verification' })).toHaveAttribute('href', `/resolve/report/${EDITION}`);
  });

  it('withdraws a publication after confirming, and then marks it as still reachable by link', async () => {
    platform.publications.mockResolvedValueOnce([publicationOf(FROZEN)]).mockResolvedValue([publicationOf(FROZEN, { withdrawn: true })]);
    platform.deletePublication.mockResolvedValue(undefined);
    renderPublications();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));

    const dialog = await screen.findByRole('dialog', { name: 'Withdraw checkout-comparison?' });
    expect(within(dialog).getByText(/Its link, citation and fingerprint keep working/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));

    expect(await screen.findByText('Withdrawn. It’s no longer listed in Explore, but its link, citation and fingerprint still work.')).toBeInTheDocument();
    expect(platform.deletePublication).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'checkout-comparison');
    expect(await screen.findByText('Withdrawn · still reachable by link')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
    // Its link and verification keep working.
    expect(screen.getByRole('link', { name: 'Open public verification' })).toBeInTheDocument();
  });

  it('reports a refusal to withdraw inside the dialog (403)', async () => {
    platform.deletePublication.mockRejectedValue(refusal(403, 'forbidden'));
    renderPublications();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));

    const dialog = await screen.findByRole('dialog', { name: 'Withdraw checkout-comparison?' });
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

    expect(await screen.findByText('checkout-comparison · published Sep 25, 2026')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open public verification' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open the report' })).not.toBeInTheDocument();
  });

  // [utest->req~frontend-retire-reports-publications-stay~1]
  it('says nothing is published yet, with no way on to the retired report list', async () => {
    platform.publications.mockResolvedValue([]);
    renderPublications();

    expect(await screen.findByText('Nothing published yet')).toBeInTheDocument();
    expect(screen.queryByText('Publish a frozen report edition from its page.')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open the reports' })).not.toBeInTheDocument();
    const hrefs = Array.from(document.querySelectorAll('a[href]')).map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.filter((href) => /\/reports([/?#]|$)/.test(href))).toEqual([]);
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
    expect(await screen.findByRole('heading', { level: 2, name: 'Engine comparison at checkout' })).toBeInTheDocument();
  });
});
