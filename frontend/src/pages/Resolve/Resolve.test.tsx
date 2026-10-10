import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { Resolve } from './Resolve';

const platform = vi.hoisted(() => ({ resolveElement: vi.fn(), resolveContent: vi.fn() }));
const auth = vi.hoisted(() => ({ user: null as UserProfile | null }));

vi.mock('../../api/platform', () => ({ platformApi: platform }));
vi.mock('../../contexts/auth', () => ({ useAuth: () => auth }));

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

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderResolve(path = `/resolve/report/${DIGEST}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/resolve/:kind/:digest" element={<Resolve />} /></Routes>
      <Where />
    </MemoryRouter>,
  );
}

const signIn = () => {
  auth.user = { id: 'u1', username: 'lucia', email: 'lucia@example.test', role: 'user', plan: 'FREE', is_active: true, created_at: '2026-01-01T00:00:00Z' };
};

describe('Resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = null;
    platform.resolveElement.mockResolvedValue(element);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('a verified element', () => {
    it('shows the verdict, identity and where it lives, without revealing the author’s email', async () => {
      renderResolve();

      expect(await screen.findByText('Verified')).toBeInTheDocument();
      expect(screen.getByText('kind · report')).toBeInTheDocument();
      expect(screen.getByText('The content’s SHA-256 matches the digest you asked for.')).toBeInTheDocument();
      expect(platform.resolveElement).toHaveBeenCalledWith('report', DIGEST, 20, 0);

      const identity = within(screen.getByRole('region', { name: 'Identity and provenance' }));
      expect(identity.getByText('Comparativa de engines en checkout')).toBeInTheDocument();
      expect(identity.getByText('JSON document (application/json)')).toBeInTheDocument();
      expect(identity.getByText('20 KiB (20,480 bytes)')).toBeInTheDocument();
      expect(identity.getByText('Sep 25, 2026, 11:55 UTC')).toBeInTheDocument();
      expect(identity.getByText('lucia.vega')).toBeInTheDocument();
      expect(identity.getByText('ISA Demo Group / QoS Benchmarks')).toBeInTheDocument();
      expect(screen.queryByText(/example\.invalid/)).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Verify by digest' })).toBeInTheDocument();
    });

    it('asks a visitor to log in before opening a location, and a member to open it', async () => {
      renderResolve();
      const locations = within(await screen.findByRole('region', { name: 'Locations' }));

      expect(locations.getByText('Public')).toBeInTheDocument();
      expect(locations.getByRole('link', { name: 'Log in to open' })).toHaveAttribute('href', '/login');
      expect(locations.queryByRole('link', { name: 'Open in platform' })).not.toBeInTheDocument();
    });

    it('links a member to the report in the platform, on a route that exists', async () => {
      signIn();
      renderResolve();
      const locations = within(await screen.findByRole('region', { name: 'Locations' }));

      expect(locations.getByRole('link', { name: 'Open in platform' })).toHaveAttribute('href', '/app/isa-demo/qos/reports/report-1');
    });

    it('describes the structure of the content without printing it', async () => {
      renderResolve();
      const content = within(await screen.findByRole('region', { name: 'Content' }));

      expect(content.getByText('Document structure')).toBeInTheDocument();
      expect(content.getByText('sections')).toBeInTheDocument();
      expect(content.getByText('2 items')).toBeInTheDocument();
      expect(content.getByText('Content matches digest')).toBeInTheDocument();
      expect(document.body.textContent).not.toContain('"sections"');
    });

    it('pages through the locations', async () => {
      platform.resolveElement.mockResolvedValue({
        ...element,
        pagination: { total: 25, limit: 20, offset: 0, has_more: true },
      });
      renderResolve();
      const locations = await screen.findByRole('region', { name: 'Locations' });

      expect(within(locations).getByText('Showing 1–1 of 25')).toBeInTheDocument();
      expect(within(locations).getByRole('button', { name: 'Previous' })).toBeDisabled();
      fireEvent.click(within(locations).getByRole('button', { name: 'Next' }));

      await waitFor(() => expect(platform.resolveElement).toHaveBeenLastCalledWith('report', DIGEST, 20, 20));
    });

    it('is not a verdict when the resolver says it could not verify', async () => {
      platform.resolveElement.mockResolvedValue({ ...element, verified: false });
      renderResolve();

      expect(await screen.findByText('Not verified')).toBeInTheDocument();
      expect(screen.queryByText('Verified')).not.toBeInTheDocument();
    });
  });

  describe('a verified element nobody can place', () => {
    it('explains that no location is visible', async () => {
      platform.resolveElement.mockResolvedValue({ ...element, locations: [], pagination: { total: 0, limit: 20, offset: 0, has_more: false } });
      renderResolve();

      expect(await screen.findByText(/none of the places it lives are visible to you/)).toBeInTheDocument();
      expect(screen.getByText('0 visible')).toBeInTheDocument();
      expect(screen.getByText('No visible location')).toBeInTheDocument();
      expect(screen.getByText('Verified')).toBeInTheDocument();
    });
  });

  describe('citing', () => {
    beforeEach(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    });

    it('copies a citation and a BibTeX entry built from what was resolved', async () => {
      renderResolve();
      const cite = within(await screen.findByRole('region', { name: 'Cite this' }));

      fireEvent.click(cite.getByRole('button', { name: 'Copy citation' }));
      const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
      expect(text).toContain('lucia.vega (2026). Comparativa de engines en checkout. OpenBinding report edition, digest sha256-e5f6…0718.');
      expect(text).not.toMatch(/doi/i);
      expect(await cite.findByRole('button', { name: 'Citation copied' })).toBeInTheDocument();

      fireEvent.click(cite.getByRole('button', { name: 'Copy for reference manager' }));
      const bibtex = vi.mocked(navigator.clipboard.writeText).mock.calls[1][0];
      expect(bibtex).toMatch(/^@misc\{lucia\.?vega2026/);
      expect(bibtex).toContain('title        = {Comparativa de engines en checkout}');
      expect(bibtex).toContain(`note         = {SHA-256 digest ${DIGEST}}`);

      fireEvent.click(cite.getByRole('button', { name: 'Copy URI' }));
      expect(vi.mocked(navigator.clipboard.writeText).mock.calls[2][0]).toBe(`${window.location.origin}/resolve/report/${DIGEST}`);
    });
  });

  describe('downloading', () => {
    beforeEach(() => {
      URL.createObjectURL = vi.fn(() => 'blob:content');
      URL.revokeObjectURL = vi.fn();
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    });

    it('fetches the bytes with the session and offers them as a file', async () => {
      platform.resolveContent.mockResolvedValue(new TextEncoder().encode('{"a":1}').buffer);
      renderResolve();

      fireEvent.click(await screen.findByRole('button', { name: 'Download content' }));

      expect(await screen.findByText('Downloaded 7 bytes of application/json.')).toBeInTheDocument();
      expect(platform.resolveContent).toHaveBeenCalledWith('report', DIGEST);
      expect(URL.createObjectURL).toHaveBeenCalledOnce();
    });

    it('says when the download fails and keeps the verdict', async () => {
      platform.resolveContent.mockRejectedValue(new HttpError(503, 'down'));
      renderResolve();

      fireEvent.click(await screen.findByRole('button', { name: 'Download content' }));

      expect(await screen.findByText(/The content could not be downloaded/)).toBeInTheDocument();
      expect(screen.getByText('Verified')).toBeInTheDocument();
    });
  });

  describe('when it cannot be verified', () => {
    it('shows progress while it checks', () => {
      platform.resolveElement.mockReturnValue(new Promise(() => undefined));
      renderResolve();

      expect(screen.getByText('Checking…')).toBeInTheDocument();
      expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    });

    it('answers a missing or private element with one neutral message', async () => {
      platform.resolveElement.mockRejectedValue(new HttpError(404, 'Element not found.'));
      renderResolve();

      expect(await screen.findByText('Nothing found for this digest')).toBeInTheDocument();
      expect(screen.getByText('404 · not_found')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('log in if you expected to have access');
    });

    it('says verification is unavailable on a 503 and tries again on request', async () => {
      platform.resolveElement.mockRejectedValueOnce(new HttpError(503, 'down'));
      renderResolve();

      expect(await screen.findByText(/Verification is unavailable right now \(HTTP 503\)/)).toBeInTheDocument();
      expect(screen.getByText(/says nothing about the element itself/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText('Verified')).toBeInTheDocument();
      expect(platform.resolveElement).toHaveBeenCalledTimes(2);
    });

    it('reports a gateway that cannot be reached', async () => {
      platform.resolveElement.mockRejectedValue(new TypeError('Failed to fetch'));
      renderResolve();

      expect(await screen.findByText(/the gateway can’t be reached/)).toBeInTheDocument();
    });

    it('shows the resolver’s own words when it refuses the request with a 422', async () => {
      platform.resolveElement.mockResolvedValue({ code: 'validation_error', detail: 'Request validation failed: limit: Input should be less than or equal to 100', diagnostics: [{ code: 'less_than_equal', message: 'Input should be less than or equal to 100', in: 'query', parameter: 'limit' }] });
      renderResolve();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The resolver refused that request (422)');
      expect(alert).toHaveTextContent('Input should be less than or equal to 100');
    });

    it('does not ask the API about a digest that is not well formed', async () => {
      renderResolve('/resolve/report/not-a-digest');

      expect(await screen.findByText('That digest isn’t well formed')).toBeInTheDocument();
      expect(screen.getByLabelText('Digest')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('Not a valid digest: use sha256- followed by 64 lowercase hex characters.')).toBeInTheDocument();
      expect(platform.resolveElement).not.toHaveBeenCalled();
    });

    it('does not ask the API about a kind it does not know', async () => {
      renderResolve('/resolve/sample/sample');

      expect(await screen.findByText('That kind isn’t supported')).toBeInTheDocument();
      expect(platform.resolveElement).not.toHaveBeenCalled();
    });
  });

  describe('the form', () => {
    it('offers every kind the resolver accepts', async () => {
      renderResolve();
      const options = within(screen.getByLabelText('Kind')).getAllByRole('option').map((option) => option.textContent);

      expect(options).toEqual([
        'report', 'artifact', 'case-revision', 'resource-revision', 'collection-revision',
        'engine', 'dialect', 'registered-resource', 'instance-snapshot', 'binding-ir',
      ]);
      await screen.findByText('Verified');
    });

    it('accepts a digest in the other spellings and goes to the canonical address', async () => {
      renderResolve();
      await screen.findByText('Verified');
      const other = 'ab'.repeat(32);

      fireEvent.change(screen.getByLabelText('Digest'), { target: { value: `SHA256:${other.toUpperCase()}` } });
      fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'engine' } });
      fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

      await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/resolve/engine/sha256-${other}`));
      await waitFor(() => expect(platform.resolveElement).toHaveBeenLastCalledWith('engine', `sha256-${other}`, 20, 0));
    });

    it('asks again when the same digest is submitted again', async () => {
      renderResolve();
      await screen.findByText('Verified');

      fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

      await waitFor(() => expect(platform.resolveElement).toHaveBeenCalledTimes(2));
    });

    it('flags a malformed digest as soon as it is submitted', async () => {
      renderResolve();
      await screen.findByText('Verified');

      fireEvent.change(screen.getByLabelText('Digest'), { target: { value: 'sha256-xyz' } });
      fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

      expect(await screen.findByText('That digest isn’t well formed')).toBeInTheDocument();
      expect(platform.resolveElement).toHaveBeenCalledOnce();
    });

    it('flags an empty digest without leaving the page', async () => {
      renderResolve();
      await screen.findByText('Verified');

      fireEvent.change(screen.getByLabelText('Digest'), { target: { value: '  ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

      expect(screen.getByLabelText('Digest')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByTestId('where')).toHaveTextContent(`/resolve/report/${DIGEST}`);
    });
  });
});
