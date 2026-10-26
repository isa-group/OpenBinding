import { render, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import type { VerifierVerdict } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { AuthContext } from '../../contexts/auth';
import { computeCanonicalDigest, computeFileSha256 } from '../../utils/canonicalDigest';
import { lucia, org, project } from '../Organization/testKit';
import { ensureSubtleCrypto } from '../Project/testKit';
import { EDITION } from '../../test/fixtures/reports';
import { Verifier } from './Verifier';

const platform = vi.hoisted(() => ({ verifierCheck: vi.fn(), verifierCheckFile: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

beforeAll(ensureSubtleCrypto);

const group = org('isa-demo', { name: 'ISA Demo Group' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });

const report = {
  entity_type: 'report', id: 'report-1', slug: 'engines-vs-seeds-informe', title_or_name: 'Comparativa de engines en checkout',
  organization_slug: 'isa-demo', project_slug: 'qos-benchmarks', created_at: '2026-09-25T09:00:00Z',
};
const elsewhere = { ...report, entity_type: 'case', id: 'case-1', slug: 'checkout-flow', title_or_name: 'Flujo de checkout (r2)', project_slug: 'checkout-privado' };

const verdict = (over: Partial<VerifierVerdict> = {}): VerifierVerdict => ({
  status: 'verified', digest: EDITION, matches: true, verified_at: '2026-10-09T10:00:00Z', detail: 'Cryptographically verified against 1 registered entities.',
  entities: [report], citation: { title: 'invented', bibtex: '@misc{invented}', markdown_badge: '', authors: ['OpenBinding Research Group'], doi: '10.1109/OPENBINDING.INVENTED' }, ...over,
});

const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });

function renderVerifier(search = '', withProject = true) {
  const context: PlatformOutletContext = {
    organizations: [group], projects: withProject ? [qos] : [], organization: group, project: withProject ? qos : undefined, loading: false, reload: vi.fn(),
  };
  return render(
    <MemoryRouter initialEntries={[`/app/verifier${search}`]}>
      <AuthContext.Provider value={{ user: lucia, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route path="/app/verifier" element={<Verifier />} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Route>
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const check = () => fireEvent.click(screen.getByRole('button', { name: 'Check' }));

describe('Verifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.verifierCheck.mockResolvedValue(verdict());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  it('asks for something to check before any check', () => {
    renderVerifier();

    expect(screen.getByRole('heading', { level: 1, name: 'Verifier' })).toBeInTheDocument();
    expect(screen.getByText(/Your browser computes the fingerprint and the server confirms it\./)).toBeInTheDocument();
    expect(screen.getByText('Enter something to check.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check' })).toBeDisabled();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Fingerprint', 'Document text', 'File']);
  });

  it('verifies a fingerprint, lists what has it and offers a citation that invents nothing', async () => {
    renderVerifier();
    fireEvent.change(screen.getByRole('textbox', { name: 'Fingerprint' }), { target: { value: `  ${EDITION.toUpperCase().replace('SHA256-', 'sha256-')}  ` } });
    check();

    const result = await screen.findByRole('region', { name: 'Verdict' });
    expect(within(result).getByText('Verified')).toBeInTheDocument();
    expect(within(result).getByText('OpenBinding recorded an element with this fingerprint.')).toBeInTheDocument();
    expect(platform.verifierCheck).toHaveBeenCalledWith({ digest: EDITION });
    expect(screen.getByText('Fingerprint you gave')).toBeInTheDocument();
    expect(screen.getByText('Recorded by OpenBinding')).toBeInTheDocument();

    const matches = screen.getByRole('region', { name: 'Matches' });
    expect(within(matches).getByText('Report edition')).toBeInTheDocument();
    expect(within(matches).getByText('Comparativa de engines en checkout')).toBeInTheDocument();
    // [utest->req~frontend-retire-reports-publications-stay~1]
    expect(within(matches).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/publications');
    expect(within(matches).getByRole('link', { name: 'Public record' })).toHaveAttribute('href', `/resolve/report/${EDITION}`);

    // Written from the record, not from the gateway's citation, whose DOI and venue are made up.
    const text = 'OpenBinding (2026). Comparativa de engines en checkout. OpenBinding report edition, digest sha256-eeee…eeee.';
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText(/INVENTED/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy citation' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(text));
    expect(await screen.findByRole('button', { name: 'Citation copied' })).toBeInTheDocument();
  });

  it('checks a fingerprint named in the address when the page opens', async () => {
    renderVerifier(`?digest=${EDITION}`);

    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Fingerprint' })).toHaveValue(EDITION);
    expect(platform.verifierCheck).toHaveBeenCalledWith({ digest: EDITION });
  });

  it('says nothing is recorded for a fingerprint that is not known', async () => {
    platform.verifierCheck.mockResolvedValue(verdict({ status: 'not_found', matches: false, entities: [], detail: 'Digest not registered in platform ledger.' }));
    renderVerifier();
    fireEvent.change(screen.getByRole('textbox', { name: 'Fingerprint' }), { target: { value: EDITION } });
    check();

    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
    expect(screen.getByText('nothing recorded')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Matches' })).not.toBeInTheDocument();
  });

  it('reads someone else’s private item exactly like a fingerprint that was never registered, and never names it', async () => {
    // The gateway filters by what the caller may see and answers the same status, fields and detail for both.
    platform.verifierCheck.mockResolvedValue(verdict({ status: 'not_found', matches: false, entities: [], detail: 'Digest not registered in platform ledger.' }));
    renderVerifier();
    fireEvent.change(screen.getByRole('textbox', { name: 'Fingerprint' }), { target: { value: EDITION } });
    check();

    expect(await screen.findByText(/Someone else’s private item reads exactly like one that was never registered/)).toBeInTheDocument();
    const verdictRegion = screen.getByRole('region', { name: 'Verdict' });
    expect(within(verdictRegion).queryByText(/isa-demo|QoS Benchmarks/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Matches' })).not.toBeInTheDocument();
  });

  it('refuses something that is not a fingerprint without asking the server', async () => {
    renderVerifier();
    fireEvent.change(screen.getByRole('textbox', { name: 'Fingerprint' }), { target: { value: 'sha256-123' } });
    check();

    expect(await screen.findByText('That can’t be checked')).toBeInTheDocument();
    expect(screen.getByText('That isn’t a valid fingerprint. A fingerprint is sha256- followed by 64 lowercase hexadecimal characters.')).toBeInTheDocument();
    expect(platform.verifierCheck).not.toHaveBeenCalled();
  });

  it('fingerprints a pasted document in the browser, whatever its spacing and key order', async () => {
    const fingerprint = await computeCanonicalDigest({ a: 2, b: 1 });
    platform.verifierCheck.mockResolvedValue(verdict({ status: 'computed', digest: fingerprint, entities: [], canonical_json: '{"a":2,"b":1}', detail: 'Calculated canonical RFC 8785 SHA-256 digest.' }));
    renderVerifier();
    fireEvent.click(screen.getByRole('tab', { name: 'Document text' }));
    fireEvent.change(screen.getByLabelText('Paste the document’s text'), { target: { value: '{ "b": 1,\n  "a": 2 }' } });
    check();

    expect(await screen.findByText('Computed, not on record')).toBeInTheDocument();
    expect(platform.verifierCheck).toHaveBeenCalledWith({ document: { b: 1, a: 2 }, digest: null });
    expect(screen.getByText('Computed in your browser')).toBeInTheDocument();
    expect(screen.getByText(fingerprint, { selector: 'div:first-child > code' })).toBeInTheDocument();
    // The normalised text is raw material: it stays behind "View source".
    expect(screen.getByLabelText('Normalised document').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByLabelText('Normalised document')).toHaveTextContent('{"a":2,"b":1}');
  });

  it('says a document does not match the fingerprint it should have', async () => {
    const computed = await computeCanonicalDigest({ a: 1 });
    platform.verifierCheck.mockResolvedValue(verdict({ status: 'mismatch', matches: false, digest: EDITION, entities: [] }));
    renderVerifier();
    fireEvent.click(screen.getByRole('tab', { name: 'Document text' }));
    fireEvent.change(screen.getByLabelText('Paste the document’s text'), { target: { value: '{"a":1}' } });
    fireEvent.change(screen.getByLabelText('Fingerprint it should have (optional)'), { target: { value: EDITION } });
    check();

    expect(await screen.findByText('Doesn’t match')).toBeInTheDocument();
    expect(platform.verifierCheck).toHaveBeenCalledWith({ document: { a: 1 }, digest: EDITION });
    expect(screen.getByText('Fingerprint you expected')).toBeInTheDocument();
    expect(screen.getByText(computed)).toBeInTheDocument();
    expect(screen.getByText(EDITION)).toBeInTheDocument();
  });

  it('warns when the browser and the server disagree about the same document', async () => {
    platform.verifierCheck.mockResolvedValue(verdict({ status: 'computed', digest: EDITION, entities: [] }));
    renderVerifier();
    fireEvent.click(screen.getByRole('tab', { name: 'Document text' }));
    fireEvent.change(screen.getByLabelText('Paste the document’s text'), { target: { value: '{"a":1}' } });
    check();

    expect(await screen.findByText('Your browser and the server disagree')).toBeInTheDocument();
  });

  it('refuses text that is not a document', async () => {
    renderVerifier();
    fireEvent.click(screen.getByRole('tab', { name: 'Document text' }));
    fireEvent.change(screen.getByLabelText('Paste the document’s text'), { target: { value: 'just words' } });
    check();

    expect(await screen.findByText(/That text isn’t a JSON document/)).toBeInTheDocument();
    expect(platform.verifierCheck).not.toHaveBeenCalled();
  });

  it('hashes a chosen file in the browser and asks the server whether it knows it', async () => {
    const file = new File(['a,b\n1,2\n'], 'results.csv', { type: 'text/csv' });
    const fingerprint = await computeFileSha256(file);
    platform.verifierCheckFile.mockResolvedValue(verdict({ status: 'computed', digest: fingerprint, entities: [], citation: null }));
    renderVerifier();
    fireEvent.click(screen.getByRole('tab', { name: 'File' }));
    fireEvent.change(screen.getByLabelText('Choose file'), { target: { files: [file] } });
    expect(screen.getByText(/results\.csv · 8 bytes/)).toBeInTheDocument();
    check();

    expect(await screen.findByText('Computed, not on record')).toBeInTheDocument();
    expect(platform.verifierCheckFile).toHaveBeenCalledWith(file, 'results.csv');
    expect(screen.getByText(fingerprint, { selector: 'div:first-child > code' })).toBeInTheDocument();
    expect(screen.queryByText('Your browser and the server disagree')).not.toBeInTheDocument();
  });

  it('keeps only the matches inside the current project when asked', async () => {
    platform.verifierCheck.mockResolvedValue(verdict({ entities: [report, elsewhere] }));
    renderVerifier();
    fireEvent.change(screen.getByRole('textbox', { name: 'Fingerprint' }), { target: { value: EDITION } });
    check();

    const matches = await screen.findByRole('region', { name: 'Matches' });
    expect(within(matches).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only show matches inside QoS Benchmarks' }));
    expect(within(matches).getAllByRole('listitem')).toHaveLength(1);
    expect(within(matches).queryByText('Flujo de checkout (r2)')).not.toBeInTheDocument();
    expect(within(matches).getByText('1 more outside the chosen project.')).toBeInTheDocument();
  });

  it('offers no project filter when the workspace has no project', () => {
    renderVerifier('', false);
    expect(screen.queryByRole('checkbox', { name: /Only show matches inside/ })).not.toBeInTheDocument();
  });

  it('puts each refusal in words: 422, 413, 403 and 503', async () => {
    renderVerifier();
    fireEvent.change(screen.getByRole('textbox', { name: 'Fingerprint' }), { target: { value: EDITION } });

    platform.verifierCheck.mockRejectedValueOnce(refusal(422, 'validation_error', 'digest is malformed'));
    check();
    expect(await screen.findByText('That isn’t a valid fingerprint or document (422 · validation_error)')).toBeInTheDocument();

    platform.verifierCheck.mockRejectedValueOnce(refusal(403, 'forbidden'));
    check();
    expect(await screen.findByText('This API key can’t use the verifier (403 · forbidden)')).toBeInTheDocument();

    platform.verifierCheck.mockRejectedValueOnce(refusal(503, 'unavailable'));
    check();
    expect(await screen.findByText('The verifier didn’t answer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'File' }));
    fireEvent.change(screen.getByLabelText('Choose file'), { target: { files: [new File(['x'], 'big.bin')] } });
    platform.verifierCheckFile.mockRejectedValueOnce(refusal(413, 'payload_too_large'));
    check();
    expect(await screen.findByText('That file is too large to check here (413 · payload_too_large)')).toBeInTheDocument();
  });

  it('says the session ended (401) and points to log in', async () => {
    platform.verifierCheck.mockRejectedValue(refusal(401, 'unauthorized'));
    renderVerifier();
    fireEvent.change(screen.getByRole('textbox', { name: 'Fingerprint' }), { target: { value: EDITION } });
    check();

    expect(await screen.findByText('Your session ended (401 · unauthorized)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
  });
});
