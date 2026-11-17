import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../core/api/http';
import { addressNow, fakeGateway, orgNode, renderModule } from '../../../../test/moduleKit';
import EditorLayout from '../../layouts/editor-layout';
import CompositionEditorPage from '.';

// Monaco needs a real browser: the editor is a textarea here, named as Monaco's is.
vi.mock('../../../core/components/code-editor', () => ({
  default: ({
    ariaLabel,
    value,
    onChange,
  }: {
    ariaLabel: string;
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={event => onChange(event.target.value)}
    />
  ),
}));

const api = vi.hoisted(() => ({
  get: vi.fn(),
  version: vi.fn(),
  content: vi.fn(),
  check: vi.fn(),
  seal: vi.fn(),
  allVersions: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
const language = vi.hoisted(() => ({
  validate: vi.fn(),
  parse: vi.fn(),
  serialise: vi.fn(),
  schema: vi.fn(),
}));
vi.mock('../../../core/utils/composition/api', () => ({
  compositionsApi: api,
  languageApi: language,
}));
vi.mock('../../../core/utils/problem/facts', () => ({ problemFactsApi: { get: vi.fn() } }));

const TEXT =
  'syntaxVersion: "1.0"\ncomposition: order-desk\nversion: 1.2.0\nkind: application\nworkflow: pick\nbinding: {pick: {candidate: c_pick}}\nvalues: {}\n';

const ORDER_DESK = {
  id: 'c1',
  slug: 'order-desk',
  name: 'Order desk',
  kind: 'application',
  description: '',
  organization: { id: 'o1', name: 'ISA demo', slug: 'isa-demo' },
  visibility: 'private',
  archived: false,
  latest_version: { id: 'v3', label: '1.2.0' },
  version_count: 3,
};

const tree = [orgNode('isa-demo', { name: 'ISA demo', effective_role: 'MEMBER' })];

function renderEditor(entry: string, user?: null) {
  return renderModule(
    <EditorLayout>
      <CompositionEditorPage />
    </EditorLayout>,
    {
      entry,
      tree,
      user,
      gateway: fakeGateway({
        'GET /v1/users/me/compositions': { body: { compositions: [ORDER_DESK], total: 1 } },
      }),
      routes: { '/compositions/:org/:composition/:tab': <p>card</p> },
    }
  );
}

const source = () => screen.findByRole('textbox', { name: 'composition.yaml source' });

beforeEach(() => {
  vi.clearAllMocks();
  language.validate.mockResolvedValue({ valid: true, diagnostics: [] });
  language.parse.mockResolvedValue({ document: {} });
  language.schema.mockResolvedValue({ properties: {} });
  api.get.mockResolvedValue({ value: ORDER_DESK, etag: '"r1"' });
  api.version.mockResolvedValue({ id: 'v3', label: '1.2.0' });
  api.content.mockResolvedValue(TEXT);
  api.check.mockResolvedValue({
    valid: true,
    values: {},
    values_status: 'declared',
    content: TEXT,
  });
  api.allVersions.mockResolvedValue([{ label: '1.0.0' }, { label: '1.2.0' }]);
});

describe('/editor', () => {
  it('opens a visitor on the starter, with the gateway’s findings and a Sign in instead of Publish', async () => {
    language.validate.mockResolvedValue({
      valid: false,
      diagnostics: [
        {
          code: 'c2y_unknown_key',
          message: 'Unknown key presentation.',
          severity: 'warning',
          path: 'presentation',
          pointer: '/presentation',
          span: { line: 1, column: 1, end_line: 1, end_column: 5 },
        },
      ],
    });
    renderEditor('/editor', null);
    expect(((await source()) as HTMLTextAreaElement).value).toContain(
      'composition: my-composition'
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Composition editor' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/language');
    const problems = await screen.findByRole('region', { name: 'Problems' });
    expect(
      await within(problems).findByRole('button', { name: /Unknown key presentation/ })
    ).toHaveTextContent('Line 1, column 1');
  });

  it('opens a version of a composition, and publishes the draft as a new version of it', async () => {
    api.seal.mockResolvedValue({ created: true, result: { version: { label: '1.3.0' } } });
    renderEditor('/editor?source=isa-demo/order-desk&version=1.2.0');
    expect(await source()).toHaveValue(TEXT);
    expect(api.content).toHaveBeenCalledWith('isa-demo', 'order-desk', 'v3');
    expect(screen.getByTitle('Editing Order desk from version 1.2.0')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Publish/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish to OpenBinding' });
    expect(within(dialog).getByRole('button', { name: /New version/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(await within(dialog).findByRole('button', { name: /Order desk/ }));
    expect(await within(dialog).findByText(/already has a version 1\.2\.0/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Publish version/ })).toBeDisabled();

    const label = within(dialog).getByLabelText(/^Version label/);
    fireEvent.change(label, { target: { value: '1.3.0' } });
    fireEvent.blur(label);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'composition.yaml source' })).toHaveValue(
        TEXT.replace('version: 1.2.0', 'version: 1.3.0')
      )
    );
    const publish = within(dialog).getByRole('button', { name: /Publish version/ });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);
    await waitFor(() =>
      expect(api.seal).toHaveBeenCalledWith(
        'isa-demo',
        'order-desk',
        TEXT.replace('version: 1.2.0', 'version: 1.3.0')
      )
    );
    await waitFor(() =>
      expect(addressNow()).toBe('/compositions/isa-demo/order-desk/versions?version=1.3.0')
    );
  });

  it('says when the composition it was opened on cannot be read', async () => {
    api.get.mockRejectedValue(new HttpError(404, 'Not found'));
    renderEditor('/editor?source=isa-demo/missing');
    expect(await screen.findByText('There is no composition to edit')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start from the starter instead' })).toHaveAttribute(
      'href',
      '/editor'
    );
  });
});
