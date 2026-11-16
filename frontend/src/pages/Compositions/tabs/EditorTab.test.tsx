import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../api/client';
import { iker, org, renderOrgScreen } from '../../../features/workspace/testKit';
import type { CompositionVersionView, CompositionView } from '../../../shared/api/types';
import { draftScope, loadDraft } from '../../../shared/editor/drafts';
import { compositionFragment } from '../../../shared/sphere/composition-fragment';
import fmsVersion from '../../../test/fixtures/core/fms.version.json';
import { CompositionDetail } from '../CompositionDetail';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  allVersions: vi.fn(),
  version: vi.fn(),
  content: vi.fn(),
  check: vi.fn(),
  seal: vi.fn(),
}));
const language = vi.hoisted(() => ({
  validate: vi.fn(),
  parse: vi.fn(),
  serialise: vi.fn(),
  schema: vi.fn(),
}));
vi.mock('../../../entities/composition/api', () => ({
  compositionsApi: api,
  languageApi: language,
}));
const factsApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../entities/problem/facts', () => ({ problemFactsApi: factsApi }));

const member = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewer = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'VIEWER' });

const composition: CompositionView = {
  id: 'composition-order',
  slug: 'order-desk',
  name: 'Order desk',
  description: '',
  kind: 'application',
  archived: false,
  visibility: 'private',
  organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' },
  created_by_id: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  version_count: 1,
  latest_version: {
    id: 'v1',
    ordinal: 1,
    label: '1.2.0',
    values_status: 'declared',
    verified: false,
    created_at: '2026-10-01T00:00:00Z',
  },
};

const TEXT =
  'syntaxVersion: "1.0"\ncomposition: order-desk\nversion: 1.2.0\nkind: application\nworkflow: pick\nbinding:\n  pick: {candidate: c_pick}\nvalues: {}\n';
const DOCUMENT = {
  syntaxVersion: '1.0',
  composition: 'order-desk',
  version: '1.2.0',
  kind: 'application',
  workflow: 'pick',
  binding: { pick: { candidate: 'c_pick' } },
  values: {},
};

function versionOf(id: string, label: string, ordinal: number): CompositionVersionView {
  const version = structuredClone(fmsVersion) as CompositionVersionView;
  return {
    ...version,
    id,
    label,
    ordinal,
    problem: null,
    values_status: 'declared',
    document: DOCUMENT,
  };
}

const v1 = versionOf('v1', '1.2.0', 1);
const sealed = (label: string) => ({
  version: versionOf('v2', label, 2),
  evaluation: v1.evaluations[0],
  diagnostics: [],
});
const SCOPE = draftScope({
  user: 'user-lucia',
  kind: 'composition',
  org: 'isa-demo',
  entity: 'order-desk',
  base: 'v1',
});

function Where() {
  const where = useLocation();
  return <output data-testid="where">{where.pathname + where.search}</output>;
}

const where = () => screen.getByTestId('where').textContent;

function renderEditor(organization = member, url = '/app/isa-demo/compositions/order-desk/editor') {
  return renderOrgScreen(
    <>
      <CompositionDetail />
      <Where />
    </>,
    {
      path: '/app/:org/compositions/:composition/:tab?',
      url,
      organizations: [organization],
    }
  );
}

function view(): EditorView {
  const editor = document.querySelector('.cm-editor');
  const found = editor instanceof HTMLElement ? EditorView.findFromDOM(editor) : null;
  if (!found) throw new Error('no code editor');
  return found;
}

/** The text in the code editor. */
const code = () => view().state.doc.toString();

const label = () => screen.getByLabelText('Label') as HTMLInputElement;

describe('Editor tab', () => {
  // jsdom lays nothing out, and its ranges cannot measure themselves; CodeMirror measures text ranges after each update.
  beforeAll(() => {
    const empty = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    };
    Range.prototype.getClientRects = () =>
      Object.assign([], { item: () => null }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => empty as DOMRect;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ value: composition, etag: 'W/"3"' });
    api.allVersions.mockResolvedValue([v1]);
    api.version.mockResolvedValue(v1);
    api.content.mockResolvedValue(TEXT);
    language.validate.mockResolvedValue({ valid: true, diagnostics: [] });
    language.parse.mockResolvedValue({ document: DOCUMENT, diagnostics: [] });
    language.schema.mockResolvedValue({ properties: {} });
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('opens the shown version’s text with its label, and seals a new version: the draft is forgotten and the version opens', async () => {
    api.seal.mockResolvedValue({ created: true, result: sealed('1.3.0') });
    renderEditor();

    expect(await screen.findByRole('tab', { name: 'Editor' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await waitFor(() => expect(code()).toBe(TEXT));
    expect(screen.getByText(/Editing from version/)).toHaveTextContent(
      'Editing from version 1.2.0.'
    );
    expect(label()).toHaveValue('1.2.0');
    await waitFor(() =>
      expect(language.validate).toHaveBeenCalledWith(TEXT, expect.any(AbortSignal))
    );

    fireEvent.change(label(), { target: { value: '1.3.0' } });
    fireEvent.blur(label());
    await waitFor(() => expect(code()).toBe(TEXT.replace('version: 1.2.0', 'version: 1.3.0')));
    fireEvent.click(screen.getByRole('button', { name: 'Seal version' }));

    await waitFor(() =>
      expect(where()).toBe('/app/isa-demo/compositions/order-desk/versions?version=1.3.0')
    );
    expect(api.seal).toHaveBeenCalledWith(
      'isa-demo',
      'order-desk',
      TEXT.replace('version: 1.2.0', 'version: 1.3.0')
    );
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Version 1.3.0 sealed.')).toBeInTheDocument();
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(await loadDraft(SCOPE)).toBeNull();
  });

  it('says when the exact version already exists, linking it', async () => {
    api.seal.mockResolvedValue({ created: false, result: sealed('1.2.0') });
    renderEditor();
    await waitFor(() => expect(code()).toBe(TEXT));

    fireEvent.click(screen.getByRole('button', { name: 'Seal version' }));
    const notice = await screen.findByText(/This exact version already exists/);
    expect(within(notice).getByRole('link', { name: '1.2.0' })).toHaveAttribute(
      'href',
      '/app/isa-demo/compositions/order-desk?version=1.2.0'
    );
    expect(where()).toBe('/app/isa-demo/compositions/order-desk/editor');
  });

  it('marks the label when another version holds it', async () => {
    api.seal.mockRejectedValue(
      Object.assign(new HttpError(409, 'Version 1.2.0 already holds another content.'), {
        code: 'version_label_taken',
      })
    );
    renderEditor();
    await waitFor(() => expect(code()).toBe(TEXT));

    fireEvent.click(screen.getByRole('button', { name: 'Seal version' }));
    expect(
      await screen.findByText('Version 1.2.0 already holds another content. Choose another label.')
    ).toBeInTheDocument();
    const problems = screen.getByRole('region', { name: 'Problems' });
    expect(
      within(problems).getByRole('button', { name: /Version 1.2.0 already holds another content/ })
    ).toHaveTextContent('Line 3, column 10');
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Seal version' })).toBeDisabled();
  });

  it('lists what the gateway refused, located in the text it was sent', async () => {
    const error = Object.assign(new HttpError(422, 'The document is not valid Composition2Yaml.'), {
      code: 'composition_invalid',
      diagnostics: [
        {
          code: 'c2y_candidate_unknown',
          message: 'No catalog holds c_pick.',
          severity: 'error',
          path: 'binding.pick.candidate',
          pointer: '/binding/pick/candidate',
          span: { line: 7, column: 21, end_line: 7, end_column: 27 },
        },
      ],
    });
    api.seal.mockRejectedValue(error);
    renderEditor();
    await waitFor(() => expect(code()).toBe(TEXT));

    fireEvent.click(screen.getByRole('button', { name: 'Seal version' }));
    expect(
      await screen.findByText(
        'The gateway refused the document. Its problems are listed with the code.'
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Problems' })).getByRole('button', {
        name: /No catalog holds c_pick/,
      })
    ).toHaveTextContent('Line 7, column 21');
  });

  it('reports a refusal that is not about the text', async () => {
    api.seal.mockRejectedValue(
      Object.assign(new HttpError(503, 'The toolchain is not available.'), {
        code: 'toolchain_unavailable',
      })
    );
    renderEditor();
    await waitFor(() => expect(code()).toBe(TEXT));

    fireEvent.click(screen.getByRole('button', { name: 'Seal version' }));
    expect(
      await screen.findByText(
        'The version couldn’t be sealed (503): The toolchain is not available.'
      )
    ).toBeInTheDocument();
  });

  it('lets a VIEWER read and check the code, never seal or change it', async () => {
    renderEditor(viewer);
    await waitFor(() => expect(code()).toBe(TEXT));
    await waitFor(() => expect(language.validate).toHaveBeenCalled());

    expect(screen.queryByRole('button', { name: 'Seal version' })).toBeNull();
    expect(screen.getAllByText(/Sealing versions needs MEMBER/).length).toBeGreaterThan(0);
    for (const name of ['Undo', 'Redo', 'Upload', 'Discard changes'])
      expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New version' })).toBeNull();
    expect(view().state.readOnly).toBe(true);
  });

  it('uploads a file as a new draft after linting it, asking before it replaces unsaved changes', async () => {
    renderEditor();
    await waitFor(() => expect(code()).toBe(TEXT));
    const uploaded = TEXT.replace('version: 1.2.0', 'version: 2.0.0');

    const upload = async (text: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
      const dialog = await screen.findByRole('dialog', { name: 'Upload Composition2Yaml' });
      const file = new File([text], 'order-desk.yaml', { type: 'application/yaml' });
      fireEvent.change(within(dialog).getByLabelText('Composition2Yaml file'), {
        target: { files: [file] },
      });
      expect(
        await within(dialog).findByText('The gateway found no problems in this file.')
      ).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Open in the editor' }));
    };

    await upload(uploaded);
    expect(language.validate).toHaveBeenCalledWith(uploaded);
    await waitFor(() => expect(code()).toBe(uploaded));
    expect(label()).toHaveValue('2.0.0');

    await upload(TEXT.replace('version: 1.2.0', 'version: 3.0.0'));
    const confirm = await screen.findByRole('dialog', { name: 'Replace your unsaved changes?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep my changes' }));
    expect(code()).toBe(uploaded);

    await upload(TEXT.replace('version: 1.2.0', 'version: 3.0.0'));
    fireEvent.click(
      within(
        await screen.findByRole('dialog', { name: 'Replace your unsaved changes?' })
      ).getByRole('button', { name: 'Replace' })
    );
    await waitFor(() => expect(label()).toHaveValue('3.0.0'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(code()).toBe(uploaded));
  });

  it('refuses a file larger than the gateway reads', async () => {
    renderEditor();
    await waitFor(() => expect(code()).toBe(TEXT));
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    const dialog = await screen.findByRole('dialog', { name: 'Upload Composition2Yaml' });
    const big = new File(['x'.repeat(256 * 1024 + 1)], 'big.yaml');
    fireEvent.change(within(dialog).getByLabelText('Composition2Yaml file'), {
      target: { files: [big] },
    });
    expect(
      await within(dialog).findByText(
        'big.yaml is larger than 256 KiB, the largest document the gateway reads.'
      )
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Open in the editor' })).toBeDisabled();
  });

  it('copies a share link that carries the text, and opens such a link as the draft', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const first = renderEditor();
    await waitFor(() => expect(code()).toBe(TEXT));
    const shared = TEXT.replace('kind: application', 'kind: system');
    fireEvent.change(label(), { target: { value: '1.2.1' } });
    fireEvent.blur(label());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const link = String(writeText.mock.calls[0][0]);
    expect(link).toContain('#composition=');
    expect(await screen.findByText(/Share link copied/)).toBeInTheDocument();
    first.unmount();

    // Another person opens a link to the editor that carries a text.
    window.history.replaceState(
      { kept: true },
      '',
      `/app/isa-demo/compositions/order-desk/editor${compositionFragment(shared)}`
    );
    renderOrgScreen(<CompositionDetail />, {
      path: '/app/:org/compositions/:composition/:tab?',
      url: '/app/isa-demo/compositions/order-desk/editor',
      organizations: [member],
      user: iker,
    });
    await waitFor(() => expect(code()).toBe(shared));
    expect(window.location.hash).toBe('');
    expect(window.history.state).toEqual({ kept: true });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(code()).toBe(TEXT));
    expect(link).toBe(
      `http://localhost:3000/${compositionFragment(TEXT.replace('version: 1.2.0', 'version: 1.2.1'))}`
    );
  });
});
