import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import examples from '../../content/composition2yaml-examples.json';
import type { CompositionDiagnosticView } from '../../modules/core/api/types';
import { compositionFragment } from '../../modules/core/utils/sphere/composition-fragment';
import {
  LANGUAGE_LINT_DELAY_MS,
  LanguagePage,
  SCHEMA_URL,
  SECTIONS,
  SPECIFICATION_URL,
  STARTER,
} from './LanguagePage';

const language = vi.hoisted(() => ({
  validate: vi.fn(),
  parse: vi.fn(),
  serialise: vi.fn(),
  schema: vi.fn(),
}));
vi.mock('../../modules/core/utils/composition/api', () => ({ languageApi: language }));

const SHARED =
  'syntaxVersion: "1.0"\ncomposition: hello\nversion: 0.1.0\nkind: workflow\nworkflow: greet\nbinding: {greet: {candidate: greeter}}\nvalues: {}\n';
const CANONICAL =
  "syntaxVersion: '1.0'\ncomposition: hello\nversion: 0.1.0\nkind: workflow\nworkflow: greet\nbinding:\n  greet:\n    candidate: greeter\nvalues: {}\n";

/** The finding the stub reports on `kind:` (line 4 of SHARED). */
const KIND: CompositionDiagnosticView = {
  code: 'c2y_kind_unknown',
  message: "'workflow' is not a kind here",
  severity: 'error',
  path: 'kind',
  pointer: '/kind',
  span: { line: 4, column: 7, end_line: 4, end_column: 15 },
};

const clean = { valid: true, diagnostics: [] };

function viewOf(container: HTMLElement): EditorView {
  const editor = container.querySelector('.cm-editor');
  const view = editor instanceof HTMLElement ? EditorView.findFromDOM(editor) : null;
  if (!view) throw new Error('no editor');
  return view;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/language']}>
      <LanguagePage delay={10} />
    </MemoryRouter>
  );
}

describe('LanguagePage', () => {
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
    language.validate.mockResolvedValue(clean);
    window.history.replaceState(null, '', '/language');
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('lints at 800 ms, the anonymous budget of the Language page', () => {
    expect(LANGUAGE_LINT_DELAY_MS).toBe(800);
  });

  it('opens on the starter and lints it with the gateway', async () => {
    const { container } = renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Composition2Yaml' })).toBeInTheDocument();
    expect(viewOf(container).state.doc.toString()).toBe(STARTER);
    await waitFor(() =>
      expect(language.validate).toHaveBeenCalledWith(STARTER, expect.any(AbortSignal))
    );
    await waitFor(() =>
      expect(screen.getByRole('toolbar', { name: 'Playground' })).toHaveTextContent(
        'Valid Composition2Yaml'
      )
    );
    expect(screen.getByRole('region', { name: 'Problems' })).toHaveTextContent('No issues');
  });

  it('loads the composition a share link carries, and takes the fragment out of the address', async () => {
    window.history.replaceState(
      { idx: 3 },
      '',
      `/language?from=docs${compositionFragment(SHARED)}`
    );
    const { container } = renderPage();

    expect(viewOf(container).state.doc.toString()).toBe(SHARED);
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?from=docs');
    expect(window.history.state).toEqual({ idx: 3 });
    await waitFor(() =>
      expect(language.validate).toHaveBeenCalledWith(SHARED, expect.any(AbortSignal))
    );
  });

  it('says when a share link cannot be read, and opens on the starter', () => {
    window.history.replaceState(null, '', '/language#composition=%%%');
    const { container } = renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The composition in this link could not be read'
    );
    expect(viewOf(container).state.doc.toString()).toBe(STARTER);
    expect(window.location.hash).toBe('');
  });

  it('copies a share link that carries the text in its fragment', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = renderPage();

    act(() => {
      const view = viewOf(container);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: SHARED } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/language${compositionFragment(SHARED)}`
      )
    );
    expect(await screen.findByText(/Share link copied/)).toBeInTheDocument();
  });

  it('marks and lists the findings of the gateway, and jumps to one from the list', async () => {
    language.validate.mockResolvedValue({ valid: false, diagnostics: [KIND] });
    window.history.replaceState(null, '', `/language${compositionFragment(SHARED)}`);
    const { container } = renderPage();

    const problems = screen.getByRole('region', { name: 'Problems' });
    const finding = await within(problems).findByRole('button', {
      name: /'workflow' is not a kind here/,
    });
    expect(finding).toHaveTextContent('Line 4, column 7');
    await waitFor(() => expect(container.querySelector('.cm-lintRange-error')).not.toBeNull());
    expect(screen.getByRole('toolbar', { name: 'Playground' })).toHaveTextContent('Not valid yet');

    fireEvent.click(finding);
    const { from, to } = viewOf(container).state.selection.main;
    expect(SHARED.slice(from, to)).toBe('workflow');
  });

  it('pauses the checks when the gateway asks it to, and says for how long', async () => {
    const busy = new HttpError(429, 'Too Many Requests');
    busy.code = 'rate_limited';
    busy.retryAfter = 7;
    language.validate.mockRejectedValue(busy);
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole('toolbar', { name: 'Playground' })).toHaveTextContent(
        /Checks paused, resuming in \d s/
      )
    );
  });

  it('shows the canonical form the gateway writes, and can use it', async () => {
    language.parse.mockResolvedValue({ document: { composition: 'hello' }, diagnostics: [] });
    language.serialise.mockResolvedValue(CANONICAL);
    window.history.replaceState(null, '', `/language${compositionFragment(SHARED)}`);
    const { container } = renderPage();

    expect(language.parse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Canonical form' }));
    const region = await screen.findByRole('region', { name: 'Canonical form' });
    expect(region.querySelector('pre')).toHaveTextContent('candidate: greeter');
    expect(language.parse).toHaveBeenCalledWith(SHARED, expect.any(AbortSignal));
    expect(language.serialise).toHaveBeenCalledWith(
      { composition: 'hello' },
      expect.any(AbortSignal)
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use the canonical form' }));
    expect(viewOf(container).state.doc.toString()).toBe(CANONICAL);
  });

  it('says a text with errors has no canonical form', async () => {
    const refusal = new HttpError(422, 'Unprocessable Content');
    refusal.code = 'composition_invalid';
    refusal.diagnostics = [KIND];
    language.parse.mockRejectedValue(refusal);
    renderPage();

    fireEvent.click(screen.getByRole('tab', { name: 'Canonical form' }));
    expect(
      await screen.findByText('The text has errors: fix them to see its canonical form.')
    ).toBeInTheDocument();
    expect(language.serialise).not.toHaveBeenCalled();
  });

  it('shows every example with what the gateway says of it, and opens one in the playground', () => {
    const { container } = renderPage();

    expect(SECTIONS).toEqual(examples.sections);
    const list = screen
      .getByRole('heading', { level: 2, name: 'The language by example' })
      .closest('section') as HTMLElement;
    const cards = within(list).getAllByRole('article');
    expect(cards).toHaveLength(SECTIONS.length);
    for (const [index, example] of SECTIONS.entries()) {
      expect(within(cards[index]).getByRole('heading', { level: 3 })).toHaveTextContent(
        example.name
      );
      expect(cards[index]).toHaveTextContent(
        example.expect === 'valid' ? 'Valid' : `Refused: ${example.expect}`
      );
    }
    const refused = SECTIONS.find(example => example.expect === 'c2y_unknown_key');
    expect(refused?.yaml).toContain('presentation:');

    fireEvent.click(
      screen.getByRole('button', { name: `Open “${SECTIONS[1].name}” in the playground` })
    );
    expect(viewOf(container).state.doc.toString()).toBe(SECTIONS[1].yaml);
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(viewOf(container).state.doc.toString()).toBe(STARTER);
  });

  it('links to the specification and the schema, and says what is not in the language', () => {
    renderPage();

    expect(screen.getByRole('link', { name: /Read the specification/ })).toHaveAttribute(
      'href',
      SPECIFICATION_URL
    );
    expect(screen.getByRole('link', { name: /Download the schema/ })).toHaveAttribute(
      'href',
      SCHEMA_URL
    );
    expect(SCHEMA_URL).toMatch(/\/v1\/compositions\/schema$/);
    const outside = screen
      .getByRole('heading', { level: 2, name: 'What is not in the language' })
      .closest('section') as HTMLElement;
    expect(outside).toHaveTextContent('Presentation');
    expect(outside).toHaveTextContent('The alternatives');
    const versions = screen
      .getByRole('heading', { level: 2, name: 'Versions of the language' })
      .closest('section') as HTMLElement;
    expect(
      within(versions).getByText('syntaxVersion: "1.0"', { selector: 'code' })
    ).toBeInTheDocument();
  });
});
