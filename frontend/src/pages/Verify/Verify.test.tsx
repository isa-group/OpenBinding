import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import type { VerifierVerdict } from '../../api/platform';
import { computeCanonicalDigest, computeFileSha256 } from '../../utils/canonicalDigest';
import { EDITION } from '../../test/fixtures/reports';
import { ensureSubtleCrypto } from '../Project/testKit';
import { Verify } from './Verify';

const platform = vi.hoisted(() => ({
  resolveElement: vi.fn(), resolveContent: vi.fn(), verifierCheck: vi.fn(), verifierCheckFile: vi.fn(),
}));
const auth = vi.hoisted(() => ({ user: null as UserProfile | null }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../contexts/auth', () => ({ useAuth: () => auth }));

beforeAll(ensureSubtleCrypto);

const HEX = 'e5f60718'.repeat(8);
const DIGEST = `sha256-${HEX}`;

const location = {
  organization: { id: 'o1', slug: 'isa-demo', name: 'ISA Demo Group' },
  project: { id: 'p1', slug: 'qos', name: 'QoS Benchmarks', visibility: 'public' },
  element_id: 'element-1',
  slug: 'report-1',
  version_or_revision: 1,
  created_at: '2026-09-25T11:55:00Z',
  web_url: '/app/isa-demo/library?artifact=1',
};

const element = {
  verified: true,
  kind: 'report',
  digest: DIGEST,
  canonical_name: 'Comparativa de engines en checkout',
  media_type: 'application/json',
  size_bytes: 20480,
  created_at: '2026-09-25T11:55:00Z',
  author: { id: 'a1', username: 'lucia.vega', email: 'lucia@example.invalid' },
  document: { title: 'Comparativa', sections: [{}, {}], schemaVersion: 1 },
  content_url: `/v1/resolve/report/${DIGEST}/content`,
  locations: [location],
  pagination: { total: 1, limit: 20, offset: 0, has_more: false },
  citation: null,
};

const report = {
  entity_type: 'report', id: 'report-1', slug: 'engines-vs-seeds-informe', title_or_name: 'Comparativa de engines en checkout',
  organization_slug: 'isa-demo', project_slug: 'qos-benchmarks', created_at: '2026-09-25T09:00:00Z',
};

const verdict = (over: Partial<VerifierVerdict> = {}): VerifierVerdict => ({
  status: 'verified', digest: EDITION, matches: true, verified_at: '2026-10-09T10:00:00Z', detail: 'Cryptographically verified against 1 registered entities.',
  entities: [report], citation: { title: 'invented', bibtex: '@misc{invented}', markdown_badge: '', authors: ['OpenBinding Research Group'], doi: '10.1109/OPENBINDING.INVENTED' }, ...over,
});

const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });

function Where() {
  const here = useLocation();
  return <output data-testid="where">{`${here.pathname}${here.search}`}</output>;
}

function renderVerify(path = '/verify') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/verify/:kind?/:digest?" element={<Verify />} /></Routes>
      <Where />
    </MemoryRouter>,
  );
}

const signIn = () => {
  auth.user = { id: 'u1', username: 'lucia', email: 'lucia@example.test', role: 'user', plan: 'FREE', is_active: true, created_at: '2026-01-01T00:00:00Z' };
};

const where = () => screen.getByTestId('where').textContent;
// By role: the tab panel of a mode is labelled by its tab, so its name would match getByLabelText too.
const field = (name: string) => screen.getByRole('textbox', { name });
const typeInto = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });
const verify = () => fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
const openMode = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

describe('Verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = null;
    platform.resolveElement.mockResolvedValue(element);
    platform.verifierCheck.mockResolvedValue(verdict());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  afterEach(() => vi.restoreAllMocks());

  describe('the page', () => {
    // [utest->req~frontend-nav-verify-page~1]
    it('is titled Verify and offers the three modes', () => {
      renderVerify();

      expect(screen.getByRole('heading', { level: 1, name: 'Verify' })).toBeInTheDocument();
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Link or digest', 'Document', 'File']);
      expect(screen.getByRole('textbox', { name: 'Link or digest' })).toBeInTheDocument();
      expect(screen.getByText('Enter a link or a digest to check.')).toBeInTheDocument();
      expect(platform.resolveElement).not.toHaveBeenCalled();
      expect(platform.verifierCheck).not.toHaveBeenCalled();
    });
  });

  describe('a permanent link in the address', () => {
    // [utest->req~frontend-nav-verify-page~1]
    // [utest->req~frontend-nav-verify-signed-out~1]
    it('resolves it once through the public resolver and shows the element, never asking the verifier', async () => {
      renderVerify(`/verify/report/${DIGEST}`);

      expect(await screen.findByText('Verified')).toBeInTheDocument();
      expect(screen.getByText('kind · report')).toBeInTheDocument();
      expect(screen.getByText('The content’s SHA-256 matches the digest you asked for.')).toBeInTheDocument();
      expect(platform.resolveElement).toHaveBeenCalledTimes(1);
      expect(platform.resolveElement).toHaveBeenCalledWith('report', DIGEST, 20, 0);
      expect(platform.verifierCheck).not.toHaveBeenCalled();
      expect(platform.verifierCheckFile).not.toHaveBeenCalled();

      const identity = within(screen.getByRole('region', { name: 'Identity and provenance' }));
      expect(identity.getByText('Comparativa de engines en checkout')).toBeInTheDocument();
      expect(identity.getByText('JSON document (application/json)')).toBeInTheDocument();
      expect(identity.getByText('20 KiB (20,480 bytes)')).toBeInTheDocument();
      expect(identity.getByText('Sep 25, 2026, 11:55 UTC')).toBeInTheDocument();
      expect(identity.getByText('lucia.vega')).toBeInTheDocument();
      expect(identity.getByText('ISA Demo Group / QoS Benchmarks')).toBeInTheDocument();
      expect(screen.queryByText(/example\.invalid/)).not.toBeInTheDocument();
    });

    // [utest->req~frontend-nav-verify-page~1]
    it('resolves it for a signed-in person too, through the same call', async () => {
      signIn();
      renderVerify(`/verify/report/${DIGEST}`);

      expect(await screen.findByText('Verified')).toBeInTheDocument();
      expect(platform.resolveElement).toHaveBeenCalledWith('report', DIGEST, 20, 0);
      expect(platform.verifierCheck).not.toHaveBeenCalled();
    });

    // [utest->req~frontend-nav-verify-page~1]
    it.each([
      'case-revision', 'resource-revision', 'collection-revision', 'report', 'artifact',
      'engine', 'dialect', 'registered-resource', 'instance-snapshot', 'binding-ir',
    ])('resolves the kind %s', async (kind) => {
      platform.resolveElement.mockResolvedValue({ ...element, kind });
      signIn();
      renderVerify(`/verify/${kind}/${DIGEST}`);

      expect(await screen.findByText(`kind · ${kind}`)).toBeInTheDocument();
      expect(platform.resolveElement).toHaveBeenCalledWith(kind, DIGEST, 20, 0);
    });

    it('asks a visitor to log in before opening a location, and a member to open it', async () => {
      renderVerify(`/verify/report/${DIGEST}`);
      const locations = within(await screen.findByRole('region', { name: 'Locations' }));

      expect(locations.getByText('Public')).toBeInTheDocument();
      expect(locations.getByRole('link', { name: 'Log in to open' })).toHaveAttribute('href', '/login');
      expect(locations.queryByRole('link', { name: 'Open in platform' })).not.toBeInTheDocument();
    });

    // [utest->req~frontend-retire-reports-no-link~1]
    it('links a member to the publications of the project of the report, on a route that exists', async () => {
      signIn();
      renderVerify(`/verify/report/${DIGEST}`);
      const locations = within(await screen.findByRole('region', { name: 'Locations' }));

      expect(locations.getByRole('link', { name: 'Open in platform' })).toHaveAttribute('href', '/app/isa-demo/qos/published');
    });

    // [utest->req~frontend-retire-library-no-link~1]
    it('links a member to the collections of the project for a resource revision, never to the retired resources', async () => {
      signIn();
      platform.resolveElement.mockResolvedValue({ ...element, kind: 'resource-revision' });
      renderVerify(`/verify/resource-revision/${DIGEST}`);
      const locations = within(await screen.findByRole('region', { name: 'Locations' }));

      expect(locations.getByRole('link', { name: 'Open in platform' })).toHaveAttribute('href', '/app/isa-demo/qos/collections');
    });

    it('describes the structure of the content without printing it', async () => {
      renderVerify(`/verify/report/${DIGEST}`);
      const content = within(await screen.findByRole('region', { name: 'Content' }));

      expect(content.getByText('Document structure')).toBeInTheDocument();
      expect(content.getByText('sections')).toBeInTheDocument();
      expect(content.getByText('2 items')).toBeInTheDocument();
      expect(content.getByText('Content matches digest')).toBeInTheDocument();
      expect(document.body.textContent).not.toContain('"sections"');
    });

    it('names the kind of a problem version in the words of the glossary', async () => {
      platform.resolveElement.mockResolvedValue({ ...element, kind: 'case-revision', canonical_name: '' });
      renderVerify(`/verify/case-revision/${DIGEST}`);
      const identity = within(await screen.findByRole('region', { name: 'Identity and provenance' }));

      expect(identity.getAllByText('Problem version').length).toBeGreaterThan(0);
      expect(screen.queryByText('Case revision')).not.toBeInTheDocument();
    });

    it('pages through the locations', async () => {
      platform.resolveElement.mockResolvedValue({
        ...element,
        pagination: { total: 25, limit: 20, offset: 0, has_more: true },
      });
      renderVerify(`/verify/report/${DIGEST}`);
      const locations = await screen.findByRole('region', { name: 'Locations' });

      expect(within(locations).getByText('Showing 1–1 of 25')).toBeInTheDocument();
      expect(within(locations).getByRole('button', { name: 'Previous' })).toBeDisabled();
      fireEvent.click(within(locations).getByRole('button', { name: 'Next' }));

      await waitFor(() => expect(platform.resolveElement).toHaveBeenLastCalledWith('report', DIGEST, 20, 20));
    });

    it('is not a verdict when the resolver says it could not verify', async () => {
      platform.resolveElement.mockResolvedValue({ ...element, verified: false });
      renderVerify(`/verify/report/${DIGEST}`);

      expect(await screen.findByText('Not verified')).toBeInTheDocument();
      expect(screen.queryByText('Verified')).not.toBeInTheDocument();
    });

    it('explains that no location is visible for an element nobody can place', async () => {
      platform.resolveElement.mockResolvedValue({ ...element, locations: [], pagination: { total: 0, limit: 20, offset: 0, has_more: false } });
      renderVerify(`/verify/report/${DIGEST}`);

      expect(await screen.findByText(/none of the places it lives are visible to you/)).toBeInTheDocument();
      expect(screen.getByText('0 visible')).toBeInTheDocument();
      expect(screen.getByText('No visible location')).toBeInTheDocument();
      expect(screen.getByText('Verified')).toBeInTheDocument();
    });
  });

  describe('copying the permanent link', () => {
    // [utest->req~frontend-nav-verify-permanent-links~1]
    it('puts the /resolve/<kind>/<digest> form on the clipboard', async () => {
      renderVerify(`/verify/report/${DIGEST}`);
      const cite = within(await screen.findByRole('region', { name: 'Cite and link' }));

      fireEvent.click(cite.getByRole('button', { name: 'Copy permanent link' }));

      expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]).toBe(`${window.location.origin}/resolve/report/${DIGEST}`);
      expect(await cite.findByText('permanent link copied')).toBeInTheDocument();
    });

    it('copies a citation and a BibTeX entry built from what was resolved, without the digest', async () => {
      renderVerify(`/verify/report/${DIGEST}`);
      const cite = within(await screen.findByRole('region', { name: 'Cite and link' }));

      fireEvent.click(cite.getByRole('button', { name: 'Copy citation' }));
      const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
      expect(text).toBe('lucia.vega (2026). Comparativa de engines en checkout. OpenBinding report edition.');
      expect(text).not.toMatch(/doi|sha256/i);
      expect(await cite.findByRole('button', { name: 'Citation copied' })).toBeInTheDocument();

      fireEvent.click(cite.getByRole('button', { name: 'Copy BibTeX' }));
      const bibtex = vi.mocked(navigator.clipboard.writeText).mock.calls[1][0];
      expect(bibtex).toMatch(/^@misc\{lucia\.?vega2026/);
      expect(bibtex).toContain('title        = {Comparativa de engines en checkout}');
    });

    // [utest->req~citation-panel~1]
    it('shows the digest exactly once, in the citation panel', async () => {
      renderVerify(`/verify/report/${DIGEST}`);
      const cite = within(await screen.findByRole('region', { name: 'Cite and link' }));

      expect(cite.getAllByText(DIGEST)).toHaveLength(1);
      expect(screen.getAllByText(DIGEST)).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Copy digest' })).toHaveLength(1);
    });

    it('names the breadcrumb by kind and never prints a digest prefix', async () => {
      renderVerify(`/verify/report/${DIGEST}`);
      await screen.findByText('Verified');

      const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
      expect(crumbs.getByText('Report edition')).toBeInTheDocument();
      expect(crumbs.queryByText(/sha256|…/)).not.toBeInTheDocument();
    });
  });

  describe('downloading', () => {
    beforeEach(() => {
      URL.createObjectURL = vi.fn(() => 'blob:content');
      URL.revokeObjectURL = vi.fn();
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    });

    it('fetches the bytes and offers them as a file named after the kind and the name, not the digest', async () => {
      const names: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) { names.push(this.download); });
      platform.resolveContent.mockResolvedValue(new TextEncoder().encode('{"a":1}').buffer);
      renderVerify(`/verify/report/${DIGEST}`);

      fireEvent.click(await screen.findByRole('button', { name: 'Download content' }));

      expect(await screen.findByText('Downloaded 7 bytes of application/json.')).toBeInTheDocument();
      expect(platform.resolveContent).toHaveBeenCalledWith('report', DIGEST);
      expect(URL.createObjectURL).toHaveBeenCalledOnce();
      expect(names).toEqual(['report-comparativa-de-engines-en-checkout.json']);
    });

    it('says when the download fails and keeps the verdict', async () => {
      platform.resolveContent.mockRejectedValue(new HttpError(503, 'down'));
      renderVerify(`/verify/report/${DIGEST}`);

      fireEvent.click(await screen.findByRole('button', { name: 'Download content' }));

      expect(await screen.findByText(/The content could not be downloaded/)).toBeInTheDocument();
      expect(screen.getByText('Verified')).toBeInTheDocument();
    });
  });

  describe('when a link cannot be verified', () => {
    it('shows progress while it checks', () => {
      platform.resolveElement.mockReturnValue(new Promise(() => undefined));
      renderVerify(`/verify/report/${DIGEST}`);

      expect(screen.getByText('Checking…')).toBeInTheDocument();
      expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    });

    // [utest->req~frontend-nav-verify-signed-out~1]
    it('answers a missing or a private element with one neutral message, the form still available', async () => {
      platform.resolveElement.mockRejectedValue(new HttpError(404, 'Element not found.'));
      renderVerify(`/verify/report/${DIGEST}`);

      expect(await screen.findByText('Nothing public matches this digest')).toBeInTheDocument();
      expect(screen.getByText('404 · not_found')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('log in if you expected to have access');
      expect(screen.getByRole('textbox', { name: 'Link or digest' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument();
    });

    it('says verification is unavailable on a 503 and tries again on request', async () => {
      platform.resolveElement.mockRejectedValueOnce(new HttpError(503, 'down'));
      renderVerify(`/verify/report/${DIGEST}`);

      expect(await screen.findByText(/Verification is unavailable right now \(HTTP 503\)/)).toBeInTheDocument();
      expect(screen.getByText(/says nothing about the element itself/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText('Verified')).toBeInTheDocument();
      expect(platform.resolveElement).toHaveBeenCalledTimes(2);
    });

    it('reports a gateway that cannot be reached', async () => {
      platform.resolveElement.mockRejectedValue(new TypeError('Failed to fetch'));
      renderVerify(`/verify/report/${DIGEST}`);

      expect(await screen.findByText(/the gateway can’t be reached/)).toBeInTheDocument();
    });

    it('shows the resolver’s own words when it refuses the request with a 422', async () => {
      platform.resolveElement.mockResolvedValue({ code: 'validation_error', detail: 'Request validation failed: limit: Input should be less than or equal to 100', diagnostics: [{ code: 'less_than_equal', message: 'Input should be less than or equal to 100', in: 'query', parameter: 'limit' }] });
      renderVerify(`/verify/report/${DIGEST}`);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The resolver refused that request (422)');
      expect(alert).toHaveTextContent('Input should be less than or equal to 100');
    });

    it('does not ask the API about a digest that is not well formed', async () => {
      renderVerify('/verify/report/not-a-digest');

      expect(await screen.findByText('That digest isn’t well formed')).toBeInTheDocument();
      expect(field('Link or digest')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('Not a valid digest: use sha256- followed by 64 lowercase hex characters.')).toBeInTheDocument();
      expect(platform.resolveElement).not.toHaveBeenCalled();
    });

    it('does not ask the API about a kind it does not know', async () => {
      renderVerify('/verify/sample/sample');

      expect(await screen.findByText('That kind isn’t supported')).toBeInTheDocument();
      expect(platform.resolveElement).not.toHaveBeenCalled();
    });
  });

  describe('the mode Link or digest, signed out', () => {
    // [utest->req~frontend-nav-verify-signed-out~1]
    it('offers every kind the resolver accepts, by its label', () => {
      renderVerify();
      const select = screen.getByLabelText('Kind');
      const options = within(select).getAllByRole('option');

      expect(options.map((option) => option.textContent)).toEqual([
        'Choose a kind', 'Report edition', 'Artifact', 'Problem version', 'Resource revision', 'Collection revision',
        'Engine', 'Dialect', 'Registered resource', 'Instance snapshot', 'Binding problem IR',
      ]);
      expect(options.map((option) => option.getAttribute('value'))).toEqual([
        '', 'report', 'artifact', 'case-revision', 'resource-revision', 'collection-revision',
        'engine', 'dialect', 'registered-resource', 'instance-snapshot', 'binding-ir',
      ]);
    });

    // [utest->req~frontend-nav-verify-page~1]
    it('turns a pasted permanent link into the address of the Verify page', async () => {
      renderVerify();

      typeInto('Link or digest', `https://ob.example/resolve/case-revision/${DIGEST}`);
      verify();

      await waitFor(() => expect(where()).toBe(`/verify/case-revision/${DIGEST}`));
      await waitFor(() => expect(platform.resolveElement).toHaveBeenLastCalledWith('case-revision', DIGEST, 20, 0));
    });

    it('also reads the /verify form of a permanent link', async () => {
      renderVerify();

      typeInto('Link or digest', `/verify/engine/${DIGEST}`);
      verify();
      await waitFor(() => expect(where()).toBe(`/verify/engine/${DIGEST}`));
    });

    // [utest->req~frontend-nav-verify-signed-out~1]
    it('shows the kind selector for /verify?digest=D and sends nothing until a kind is chosen', async () => {
      renderVerify(`/verify?digest=${DIGEST}`);

      expect(field('Link or digest')).toHaveValue(DIGEST);
      expect(screen.getByLabelText('Kind')).toHaveValue('');
      expect(screen.getByText(/Choose what kind of element the digest names/)).toBeInTheDocument();
      expect(platform.resolveElement).not.toHaveBeenCalled();
      expect(platform.verifierCheck).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'case-revision' } });

      await waitFor(() => expect(where()).toBe(`/verify/case-revision/${DIGEST}`));
      await waitFor(() => expect(platform.resolveElement).toHaveBeenCalledWith('case-revision', DIGEST, 20, 0));
      expect(platform.verifierCheck).not.toHaveBeenCalled();
    });

    it('asks for a kind when a bare digest is submitted without one, and stays on the page', () => {
      renderVerify();

      typeInto('Link or digest', DIGEST);
      verify();

      expect(screen.getByLabelText('Kind')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText(/Choose what kind of element the digest names/)).toBeInTheDocument();
      expect(where()).toBe('/verify');
      expect(platform.resolveElement).not.toHaveBeenCalled();
    });

    // [utest->req~frontend-nav-verify-signed-out~1]
    it('shows the kind selector only when neither the address nor the pasted link names a kind', async () => {
      const first = renderVerify();
      expect(screen.getByLabelText('Kind')).toBeInTheDocument();

      typeInto('Link or digest', `https://ob.example/resolve/engine/${DIGEST}`);
      expect(screen.queryByLabelText('Kind')).not.toBeInTheDocument();
      typeInto('Link or digest', DIGEST);
      expect(screen.getByLabelText('Kind')).toBeInTheDocument();
      first.unmount();

      renderVerify(`/verify/report/${DIGEST}`);
      await screen.findByText('Verified');
      expect(screen.queryByLabelText('Kind')).not.toBeInTheDocument();
    });

    it('looks a bare digest up with the kind of the address', async () => {
      renderVerify(`/verify/report/${DIGEST}`);
      await screen.findByText('Verified');
      const other = 'cd'.repeat(32);

      typeInto('Link or digest', other);
      verify();

      await waitFor(() => expect(where()).toBe(`/verify/report/sha256-${other}`));
    });

    it('accepts a digest in the other spellings and goes to the canonical address', async () => {
      renderVerify();
      const other = 'ab'.repeat(32);

      typeInto('Link or digest', `SHA256:${other.toUpperCase()}`);
      fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'engine' } });
      verify();

      await waitFor(() => expect(where()).toBe(`/verify/engine/sha256-${other}`));
      await waitFor(() => expect(platform.resolveElement).toHaveBeenLastCalledWith('engine', `sha256-${other}`, 20, 0));
    });

    it('asks again when the same digest is submitted again', async () => {
      renderVerify(`/verify/report/${DIGEST}`);
      await screen.findByText('Verified');

      verify();

      await waitFor(() => expect(platform.resolveElement).toHaveBeenCalledTimes(2));
    });

    it('flags a malformed digest as soon as it is submitted', async () => {
      renderVerify(`/verify/report/${DIGEST}`);
      await screen.findByText('Verified');

      typeInto('Link or digest', 'sha256-xyz');
      verify();

      expect(await screen.findByText('That digest isn’t well formed')).toBeInTheDocument();
      expect(platform.resolveElement).toHaveBeenCalledOnce();
    });

    it('flags an empty field without leaving the page', async () => {
      renderVerify(`/verify/report/${DIGEST}`);
      await screen.findByText('Verified');

      typeInto('Link or digest', '  ');
      verify();

      expect(field('Link or digest')).toHaveAttribute('aria-invalid', 'true');
      expect(where()).toBe(`/verify/report/${DIGEST}`);
    });
  });

  describe('the modes Document and File, signed out', () => {
    // [utest->req~frontend-nav-verify-signed-out~1]
    it.each(['Document', 'File'])('say to log in in the mode %s, with a link to /login, and offer no field', (mode) => {
      renderVerify();

      openMode(mode);

      expect(screen.getByText('Log in to check a document or a file')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
      expect(screen.queryByLabelText('Paste the document’s text')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Choose file')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
      expect(platform.verifierCheck).not.toHaveBeenCalled();
      expect(platform.verifierCheckFile).not.toHaveBeenCalled();
    });

    // [utest->req~frontend-nav-verify-signed-out~1]
    it('promises no return to the Verify page: the link is a plain /login', () => {
      renderVerify(`/verify/report/${DIGEST}`);
      openMode('Document');

      const link = screen.getByRole('link', { name: 'Log in' });
      expect(link.getAttribute('href')).toBe('/login');
      expect(link.getAttribute('href')).not.toMatch(/verify|redirect|return/i);
    });
  });

  describe('signed in', () => {
    beforeEach(signIn);

    // [utest->req~frontend-nav-verify-page~1]
    it('runs the verifier on arrival at /verify?digest=D and lists what has the digest', async () => {
      renderVerify(`/verify?digest=${EDITION}`);

      const result = await screen.findByRole('status', { name: 'Verdict' });
      expect(within(result).getByText('Verified')).toBeInTheDocument();
      expect(field('Link or digest')).toHaveValue(EDITION);
      expect(platform.verifierCheck).toHaveBeenCalledWith({ digest: EDITION });
      expect(platform.resolveElement).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Kind')).not.toBeInTheDocument();
    });

    // [utest->req~frontend-nav-verify-page~1]
    it('sends a bare digest to /verify?digest=D and runs the verifier there', async () => {
      renderVerify();

      typeInto('Link or digest', `  ${EDITION.toUpperCase().replace('SHA256-', 'sha256-')}  `);
      verify();

      await waitFor(() => expect(where()).toBe(`/verify?digest=${EDITION}`));
      const result = await screen.findByRole('status', { name: 'Verdict' });
      expect(within(result).getByText('Verified')).toBeInTheDocument();
      expect(within(result).getByText('The fingerprint is what OpenBinding recorded.')).toBeInTheDocument();
      expect(platform.verifierCheck).toHaveBeenCalledWith({ digest: EDITION });
      expect(screen.getByText('Fingerprint you gave')).toBeInTheDocument();
      expect(screen.getByText('Recorded by OpenBinding')).toBeInTheDocument();
    });

    it('lists the matches with their links and offers a citation that invents nothing', async () => {
      renderVerify(`/verify?digest=${EDITION}`);

      const matches = await screen.findByRole('region', { name: 'Matches' });
      expect(within(matches).getByText('Report edition')).toBeInTheDocument();
      expect(within(matches).getByText('Comparativa de engines en checkout')).toBeInTheDocument();
      // [utest->req~frontend-retire-reports-publications-stay~1]
      expect(within(matches).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/published');
      expect(within(matches).getByRole('link', { name: 'Public record' })).toHaveAttribute('href', `/resolve/report/${EDITION}`);

      // Written from the record, not from the gateway's citation, whose DOI and venue are made up.
      const text = 'OpenBinding (2026). Comparativa de engines en checkout. OpenBinding report edition.';
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.queryByText(/INVENTED/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Copy citation' }));
      await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(text));
      expect(await screen.findByRole('button', { name: 'Citation copied' })).toBeInTheDocument();
    });

    // [utest->req~verify-result~1]
    it('shows the digest of a verified lookup exactly once in the result', async () => {
      renderVerify(`/verify?digest=${EDITION}`);
      await screen.findByRole('status', { name: 'Verdict' });

      expect(screen.getAllByText(EDITION)).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: /^Copy .*(fingerprint|digest)/ })).toHaveLength(1);
    });

    // [utest->req~verify-result~1]
    it('shows two different digests, one each, when the recorded one differs from the one given', async () => {
      const recorded = `sha256-${'12'.repeat(32)}`;
      platform.verifierCheck.mockResolvedValue(verdict({ digest: recorded }));
      renderVerify(`/verify?digest=${EDITION}`);
      await screen.findByRole('status', { name: 'Verdict' });

      expect(screen.getAllByText(EDITION)).toHaveLength(1);
      expect(screen.getAllByText(recorded)).toHaveLength(1);
    });

    it('shows every match, without a project filter', async () => {
      const elsewhere = { ...report, entity_type: 'case', id: 'case-1', slug: 'checkout-flow', title_or_name: 'Flujo de checkout (r2)', project_slug: 'checkout-privado' };
      platform.verifierCheck.mockResolvedValue(verdict({ entities: [report, elsewhere] }));
      renderVerify(`/verify?digest=${EDITION}`);

      const matches = await screen.findByRole('region', { name: 'Matches' });
      expect(within(matches).getAllByRole('listitem')).toHaveLength(2);
      expect(within(matches).getByText('Problem version')).toBeInTheDocument();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('says nothing is recorded for a fingerprint that is not known, and never names a private item', async () => {
      platform.verifierCheck.mockResolvedValue(verdict({ status: 'not_found', matches: false, entities: [], detail: 'Digest not registered in platform ledger.' }));
      renderVerify(`/verify?digest=${EDITION}`);

      expect(await screen.findByText('Nothing found')).toBeInTheDocument();
      expect(screen.getByText('nothing recorded')).toBeInTheDocument();
      expect(screen.getByText(/Someone else’s private item reads exactly like one that was never registered/)).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Matches' })).not.toBeInTheDocument();
      expect(within(screen.getByRole('status', { name: 'Verdict' })).queryByText(/isa-demo|QoS Benchmarks/)).not.toBeInTheDocument();
    });

    it('refuses something that is not a fingerprint without asking the server', async () => {
      renderVerify(`/verify?digest=sha256-123`);

      expect(await screen.findByText('That can’t be checked')).toBeInTheDocument();
      expect(screen.getByText('That isn’t a valid fingerprint. A fingerprint is sha256- followed by 64 lowercase hexadecimal characters.')).toBeInTheDocument();
      expect(platform.verifierCheck).not.toHaveBeenCalled();
    });

    // [utest->req~frontend-nav-verify-page~1]
    it('fingerprints a pasted document in the browser, whatever its spacing and key order', async () => {
      const fingerprint = await computeCanonicalDigest({ a: 2, b: 1 });
      platform.verifierCheck.mockResolvedValue(verdict({ status: 'computed', digest: fingerprint, entities: [], canonical_json: '{"a":2,"b":1}', detail: 'Calculated canonical RFC 8785 SHA-256 digest.' }));
      renderVerify();
      openMode('Document');
      typeInto('Paste the document’s text', '{ "b": 1,\n  "a": 2 }');
      verify();

      expect(await screen.findByText('Computed, not on record')).toBeInTheDocument();
      expect(platform.verifierCheck).toHaveBeenCalledWith({ document: { b: 1, a: 2 }, digest: null });
      expect(platform.verifierCheckFile).not.toHaveBeenCalled();
      expect(screen.getByText('Computed in your browser')).toBeInTheDocument();
      expect(screen.getByText(fingerprint)).toBeInTheDocument();
    });

    // [utest->req~frontend-nav-verify-no-raw-json~1]
    it('keeps the canonical JSON in a collapsed disclosure that opens a SourceView region', async () => {
      platform.verifierCheck.mockResolvedValue(verdict({ status: 'computed', digest: EDITION, entities: [], canonical_json: '{"a":2,"b":1}' }));
      renderVerify();
      openMode('Document');
      typeInto('Paste the document’s text', '{"b":1,"a":2}');
      verify();
      await screen.findByText('Computed, not on record');

      const summary = screen.getByText('Canonical JSON', { selector: 'summary' });
      const details = summary.closest('details');
      expect(details).not.toBeNull();
      expect(details).not.toHaveAttribute('open');
      const region = screen.getByRole('region', { name: 'Canonical JSON', hidden: true });
      expect(region).not.toBeVisible();

      details?.setAttribute('open', '');
      expect(region).toBeVisible();
      expect(within(region).getByRole('button', { name: 'Copy Canonical JSON' })).toBeInTheDocument();
      expect(region).toHaveTextContent('{"a":2,"b":1}');
    });

    // [utest->req~frontend-nav-verify-no-raw-json~1]
    it('has no raw block: every pre element of the page is inside a SourceView region', async () => {
      platform.verifierCheck.mockResolvedValue(verdict({ status: 'computed', digest: EDITION, entities: [], canonical_json: '{"a":2,"b":1}' }));
      renderVerify();
      openMode('Document');
      typeInto('Paste the document’s text', '{"b":1,"a":2}');
      verify();
      await screen.findByText('Computed, not on record');
      document.querySelector('details')?.setAttribute('open', '');

      const blocks = [...document.querySelectorAll('pre')];
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) expect(block.closest('[role="region"][aria-label]'), block.outerHTML).not.toBeNull();
    });

    it('says a document does not match the fingerprint it should have', async () => {
      const computed = await computeCanonicalDigest({ a: 1 });
      platform.verifierCheck.mockResolvedValue(verdict({ status: 'mismatch', matches: false, digest: EDITION, entities: [] }));
      renderVerify();
      openMode('Document');
      typeInto('Paste the document’s text', '{"a":1}');
      typeInto('Fingerprint it should have (optional)', EDITION);
      verify();

      expect(await screen.findByText('Doesn’t match')).toBeInTheDocument();
      expect(platform.verifierCheck).toHaveBeenCalledWith({ document: { a: 1 }, digest: EDITION });
      expect(screen.getByText('Fingerprint you expected')).toBeInTheDocument();
      expect(screen.getByText(computed)).toBeInTheDocument();
      expect(screen.getByText(EDITION)).toBeInTheDocument();
    });

    it('warns when the browser and the server disagree about the same document', async () => {
      platform.verifierCheck.mockResolvedValue(verdict({ status: 'computed', digest: EDITION, entities: [] }));
      renderVerify();
      openMode('Document');
      typeInto('Paste the document’s text', '{"a":1}');
      verify();

      expect(await screen.findByText('Your browser and the server disagree')).toBeInTheDocument();
    });

    it('refuses text that is not a document', async () => {
      renderVerify();
      openMode('Document');
      typeInto('Paste the document’s text', 'just words');
      verify();

      expect(await screen.findByText(/That text isn’t a JSON document/)).toBeInTheDocument();
      expect(platform.verifierCheck).not.toHaveBeenCalled();
    });

    // [utest->req~frontend-nav-verify-page~1]
    it('hashes a chosen file in the browser and posts it to the file verifier', async () => {
      const file = new File(['a,b\n1,2\n'], 'results.csv', { type: 'text/csv' });
      const fingerprint = await computeFileSha256(file);
      platform.verifierCheckFile.mockResolvedValue(verdict({ status: 'computed', digest: fingerprint, entities: [], citation: null }));
      renderVerify();
      openMode('File');
      fireEvent.change(screen.getByLabelText('Choose file'), { target: { files: [file] } });
      expect(screen.getByText(/results\.csv · 8 bytes/)).toBeInTheDocument();
      verify();

      expect(await screen.findByText('Computed, not on record')).toBeInTheDocument();
      expect(platform.verifierCheckFile).toHaveBeenCalledWith(file, 'results.csv');
      expect(platform.verifierCheck).not.toHaveBeenCalled();
      expect(screen.getByText(fingerprint)).toBeInTheDocument();
      expect(screen.queryByText('Your browser and the server disagree')).not.toBeInTheDocument();
    });

    it('puts each refusal in words: 422, 413, 403 and 503', async () => {
      renderVerify();
      openMode('Document');
      typeInto('Paste the document’s text', '{"a":1}');

      platform.verifierCheck.mockRejectedValueOnce(refusal(422, 'validation_error', 'digest is malformed'));
      verify();
      expect(await screen.findByText('That isn’t a valid fingerprint or document (422 · validation_error)')).toBeInTheDocument();

      platform.verifierCheck.mockRejectedValueOnce(refusal(403, 'forbidden'));
      verify();
      expect(await screen.findByText('This API key can’t use the verifier (403 · forbidden)')).toBeInTheDocument();

      platform.verifierCheck.mockRejectedValueOnce(refusal(503, 'unavailable'));
      verify();
      expect(await screen.findByText('The verifier didn’t answer')).toBeInTheDocument();

      openMode('File');
      fireEvent.change(screen.getByLabelText('Choose file'), { target: { files: [new File(['x'], 'big.bin')] } });
      platform.verifierCheckFile.mockRejectedValueOnce(refusal(413, 'payload_too_large'));
      verify();
      expect(await screen.findByText('That file is too large to check here (413 · payload_too_large)')).toBeInTheDocument();
    });

    it('runs one check at a time: a document cannot be sent while the check on arrival is still running', async () => {
      let release: (value: VerifierVerdict) => void = () => undefined;
      platform.verifierCheck.mockReturnValueOnce(new Promise<VerifierVerdict>((resolve) => { release = resolve; }));
      renderVerify(`/verify?digest=${EDITION}`);
      openMode('Document');
      typeInto('Paste the document’s text', '{"a":1}');

      expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
      expect(screen.getByText('Computing in your browser and asking the server…')).toBeInTheDocument();

      await act(async () => { release(verdict()); });

      expect(await screen.findByText('Verified')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Verify' })).toBeEnabled();
      expect(platform.verifierCheck).toHaveBeenCalledTimes(1);
    });

    it('says the session ended (401) and points to log in', async () => {
      platform.verifierCheck.mockRejectedValue(refusal(401, 'unauthorized'));
      renderVerify(`/verify?digest=${EDITION}`);

      expect(await screen.findByText('Your session ended (401 · unauthorized)')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    });
  });
});
