import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { caseOf, org, renderOrgScreen, revisionOf } from '../../features/workspace/testKit';
import { ProblemDetail } from './ProblemDetail';
import { checkoutFacts, compiledDocument, digestOf } from './fixtures';

const problems = vi.hoisted(() => ({
  get: vi.fn(),
  revisions: vi.fn(),
  revision: vi.fn(),
  source: vi.fn(),
  compilation: vi.fn(),
  ir: vi.fn(),
}));
const download = vi.hoisted(() => ({ saveBytes: vi.fn() }));

const facts = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../entities/problem/facts', async actual => ({
  ...(await actual<typeof import('../../entities/problem/facts')>()),
  problemFactsApi: facts,
}));
vi.mock('../../features/workspace/download', () => download);
const rendering = vi.hoisted(() => ({ saveText: vi.fn() }));
const { saveText } = rendering;
vi.mock('../../components/rendering/download', () => rendering);

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const checkout = caseOf('flujo-checkout', 'Flujo de checkout');
const r2 = revisionOf(checkout, 2, {
  package_digest: digestOf('b'),
  instance_digest: digestOf('a'),
  package_size: 48_213,
});
const root = '/app/isa-demo';

const refusal = (status: number, code = 'refused') =>
  Object.assign(new HttpError(status, 'refused'), { code });
const detail = {
  ...r2,
  document: { apiVersion: 'bim/v1', kind: 'Instance' },
  resource_digests: { app: digestOf('3') },
  compilations: [],
  files: [
    { path: 'instance.json', role: 'root', digest: digestOf('1'), media_type: 'application/json' },
    {
      path: 'application.json',
      role: 'application',
      resource_id: 'app',
      digest: digestOf('2'),
      media_type: 'application/json',
    },
  ],
};
const compilationOf = (over: Record<string, unknown> = {}) => ({
  id: 'compilation-2',
  revision_id: r2.id,
  compilation_digest: digestOf('9'),
  compiler_digest: digestOf('8'),
  ir_digest: digestOf('c'),
  binding_space: '1920',
  created_at: '2026-08-20T10:05:00Z',
  current: true,
  toolchain: {},
  analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '1920' },
  resources: {
    app: {
      role: 'application',
      path: 'application.json',
      apiVersion: 'qos-binding/v1',
      kind: 'Application',
    },
  },
  compatible_modes: [{ compatible: true }, { compatible: true }],
  ...over,
});

/** The Source tab of the problem page, showing version 2. */
function renderSource(address = '/source?version=2') {
  return renderOrgScreen(<ProblemDetail />, {
    path: '/app/:org/problems/:case/:tab?',
    url: `${root}/problems/flujo-checkout${address}`,
    organizations: [group],
  });
}

async function zipBuffer() {
  const zip = new JSZip();
  zip.file('instance.json', '{"kind":"Instance"}');
  zip.file('application.json', '{"kind":"Application"}');
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('Source tab of the problem page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.get.mockResolvedValue(checkout);
    problems.revisions.mockResolvedValue([revisionOf(checkout, 1), r2]);
    problems.revision.mockResolvedValue(detail);
    problems.compilation.mockResolvedValue(compilationOf());
    problems.ir.mockResolvedValue({
      id: 'compilation-2',
      ir_digest: digestOf('c'),
      ir: compiledDocument(),
      source_map: {},
    });
    facts.get.mockResolvedValue(checkoutFacts());
    problems.source.mockResolvedValue(new ArrayBuffer(8));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('opens the files of the package of the version on show, reading its source only when that view opens', async () => {
    problems.source.mockResolvedValue(await zipBuffer());
    renderSource();

    const list = await screen.findByRole('list', { name: 'Files in the package' });
    expect(screen.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true');
    expect(problems.source).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', 2);
    expect(
      within(list)
        .getAllByRole('button')
        .map(button => button.querySelector('code')?.textContent)
        .sort()
    ).toEqual(['application.json', 'instance.json']);
    fireEvent.click(within(list).getByRole('button', { name: /instance\.json/ }));
    const view = await screen.findByRole('region', { name: 'instance.json' });
    await waitFor(() => expect(view).toHaveTextContent('{"kind":"Instance"}'));
    fireEvent.click(within(view).getByRole('button', { name: 'Download instance.json' }));
    expect(saveText).toHaveBeenCalledWith('{"kind":"Instance"}', 'instance.json', 'text/plain');
  });

  it('shows the compiled form of the current compilation as a source view with a download', async () => {
    renderSource();

    fireEvent.click(await screen.findByRole('button', { name: 'Compiled form (JSON)' }));
    const view = await screen.findByRole('region', { name: 'Compiled form (JSON)' });
    expect(view).toHaveTextContent('"kind": "BindingProblem"');
    expect(problems.ir).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', 2, 'compilation-2');
    expect(facts.get).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', 2, 'compilation-2');
    fireEvent.click(within(view).getByRole('button', { name: 'Download Compiled form (JSON)' }));
    expect(saveText).toHaveBeenCalledWith(
      expect.stringContaining('"kind": "BindingProblem"'),
      'flujo-checkout-v2-compiled.json',
      'application/json'
    );
  });

  it('shows the three fingerprints and copies each one whole, or all together', async () => {
    renderSource();

    const section = (await screen.findByRole('heading', { name: 'Fingerprints' })).closest(
      'section'
    ) as HTMLElement;
    await waitFor(() => expect(within(section).getAllByText('Stored')).toHaveLength(3));
    expect(section.textContent).not.toMatch(/sha256-|[0-9a-f]{12}/);
    fireEvent.click(within(section).getByRole('button', { name: 'Copy full package fingerprint' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(digestOf('b')));
    fireEvent.click(within(section).getByRole('button', { name: 'Copy all fingerprints' }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        `instance ${digestOf('a')}\npackage ${digestOf('b')}\ncompiled ${digestOf('c')}`
      )
    );
  });

  it('lists the fingerprint of every file and resource of the version', async () => {
    renderSource();

    const details = (await screen.findByText('Per-file and per-resource fingerprints')).closest(
      'details'
    ) as HTMLElement;
    expect(within(details).getByRole('table', { name: 'Files (2)' })).toBeInTheDocument();
    expect(within(details).getByRole('row', { name: /instance\.json/ })).toHaveTextContent(
      'Copy digest'
    );
    expect(within(details).getByRole('table', { name: 'Resources (1)' })).toBeInTheDocument();
    expect(details.textContent).not.toMatch(/sha256-|[0-9a-f]{12}/);
  });

  it('names the resources the compiler read with the language each is written in', async () => {
    renderSource();

    const section = await screen.findByRole('region', { name: 'Exact language used' });
    expect(await within(section).findByRole('table', { name: 'Resources' })).toHaveTextContent(
      'appapplicationApplicationqos-binding/v1'
    );
  });

  it('says the language cannot be listed without a compilation', async () => {
    problems.compilation.mockRejectedValue(refusal(503, 'unavailable'));
    renderSource();

    const section = await screen.findByRole('region', { name: 'Exact language used' });
    expect(
      await within(section).findByText(
        'The compilation isn’t available, so the language it used can’t be listed.'
      )
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        'The gateway’s analysis of this version isn’t available right now (503 · unavailable).'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'What the engines receive' })
    ).not.toBeInTheDocument();
  });

  it('summarizes what the engines receive, from the compilation and the goal terms of its facts', async () => {
    renderSource();

    const section = await screen.findByRole('region', { name: 'What the engines receive' });
    const figures = await within(section).findByRole('list', { name: 'What the engines receive' });
    expect(
      within(figures)
        .getAllByRole('listitem')
        .map(item => item.textContent)
    ).toEqual(['6tasks', '24candidates', '2rules', '2goal terms', '10^3.3combinations']);
    expect(within(section).getByText('Exactly 1,920 possible bindings.')).toBeInTheDocument();
    expect(within(section).getByText('2 engine modes can run it.')).toBeInTheDocument();
  });

  it('says the installed toolchain refuses a stored package, and keeps the package and its fingerprints', async () => {
    problems.compilation.mockRejectedValue(refusal(422, 'revision_not_recompilable'));
    renderSource();

    const section = await screen.findByRole('region', { name: 'What the engines receive' });
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'The installed toolchain refuses this package (422 · revision_not_recompilable)'
    );
    expect(screen.getByRole('heading', { name: 'Fingerprints' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compiled form (JSON)' })).toBeDisabled();
  });

  it('lists the candidates that carry a range and warns that engines taking single values only cannot run it', async () => {
    problems.compilation.mockResolvedValue(
      compilationOf({
        compatible_modes: [{ compatible: true }, { compatible: false }, { compatible: false }],
      })
    );
    renderSource();

    const ranges = await screen.findByRole('region', { name: 'Range features' });
    expect(ranges).toHaveTextContent(
      'Engines that only accept single values can’t run it (2 of 3 modes listed refuse it).'
    );
    const list = within(ranges).getByRole('list', { name: 'Candidates with ranges' });
    const third = within(list).getByText('authenticate-3').closest('li') as HTMLElement;
    expect(within(third).getByText('latency ≥ 100')).toHaveAttribute('title', '[100, +∞)');
  });

  describe('downloads', () => {
    it('hands over the package as uploaded, and the compiled form as JSON', async () => {
      const buffer = new ArrayBuffer(16);
      problems.source.mockResolvedValue(buffer);
      renderSource();

      const card = await screen.findByRole('button', { name: /^Package/ });
      expect(card).toHaveTextContent(
        'flujo-checkout-v2.bim.zip · 47.1 KiB (48,213 bytes) · as uploaded'
      );
      fireEvent.click(card);
      await waitFor(() =>
        expect(download.saveBytes).toHaveBeenCalledWith(
          buffer,
          'flujo-checkout-v2.bim.zip',
          'application/vnd.bim+zip'
        )
      );
      expect(await within(card).findByText('Downloaded')).toBeInTheDocument();

      const compiled = screen.getByRole('button', { name: /^Compiled formFor tools/ });
      await waitFor(() => expect(compiled).toBeEnabled());
      fireEvent.click(compiled);
      await waitFor(() =>
        expect(download.saveBytes).toHaveBeenCalledWith(
          expect.anything(),
          'flujo-checkout-v2-compiled.json',
          'application/json'
        )
      );
    });

    it('says when a download did not finish and offers it again', async () => {
      // The file view of the Source tab reads the package first; both reads are refused, the next one goes through.
      problems.source
        .mockRejectedValueOnce(refusal(403, 'forbidden'))
        .mockRejectedValueOnce(refusal(403, 'forbidden'));
      renderSource();

      const card = await screen.findByRole('button', { name: /^Package/ });
      fireEvent.click(card);
      expect(
        await within(card).findByText('The download didn’t finish (403 · forbidden).')
      ).toBeInTheDocument();
      expect(download.saveBytes).not.toHaveBeenCalled();
      fireEvent.click(card);
      expect(await within(card).findByText('Downloaded')).toBeInTheDocument();
    });
  });

  describe('when the version cannot be shown', () => {
    it('answers a version that is gone like one that does not exist (404)', async () => {
      problems.revision.mockRejectedValue(refusal(404, 'not_found'));
      renderSource();

      expect(await screen.findByRole('heading', { name: 'Version not found' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'All problems' })).toHaveAttribute(
        'href',
        `${root}/problems`
      );
      expect(screen.queryByRole('heading', { name: 'Fingerprints' })).not.toBeInTheDocument();
    });

    it('says the API key lacks the permission (403)', async () => {
      problems.revision.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
      renderSource();

      expect(
        await screen.findByText(
          'This API key doesn’t include “read problems” (403). Use a session or a key with that permission.'
        )
      ).toBeInTheDocument();
    });

    it('offers a retry when the gateway fails', async () => {
      problems.revision.mockRejectedValueOnce(refusal(503, 'unavailable'));
      renderSource();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The source couldn’t be loaded (503 · unavailable).');
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('heading', { name: 'Fingerprints' })).toBeInTheDocument();
    });
  });
});
