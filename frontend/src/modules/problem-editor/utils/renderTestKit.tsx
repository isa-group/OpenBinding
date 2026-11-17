import { fireEvent, screen, within } from '@testing-library/react';
import type { UserProfile } from '../../../api/auth';
import { addressNow, ME, orgNode, renderModule } from '../../../test/moduleKit';
import type { OrgRole } from '../../organization/api/organizationsApi';
import ProblemEditorLayout from '../layouts/editor-layout';
import ProblemEditorPage from '../pages/problem-editor';

// The problem editor rendered at its address, in its layout, for the tests that drive it as a person would. A test that renders
// it mocks the code editor (core/components/code-editor) with codeEditorTestKit, since Monaco needs a real browser.

export interface RenderOptions {
  /** The account's role in the organization the address names. */
  role?: OrgRole;
  /** The organization the address names (`?org=`); null for none. */
  org?: string | null;
  /** The rest of the editor's query (`?problem=…`). */
  query?: string;
  /** The live check's delay; long by default, so a test checks with "Check now". */
  delay?: number;
  /** The signed-in account; null for a visitor. */
  user?: UserProfile | null;
}

/** The account the tests sign in with: its id names the drafts it keeps. */
export const ACCOUNT: UserProfile = { ...ME, id: 'user-lucia' };

/** The editor's address for the options: `/problem-editor?org=…&…`. */
export function editorAddress({ org = 'isa-demo', query = '' }: RenderOptions = {}): string {
  const params = new URLSearchParams(query.replace(/^\?/, ''));
  const all = new URLSearchParams(org ? { org } : {});
  params.forEach((value, key) => all.append(key, value));
  const search = all.toString();
  return `/problem-editor${search ? `?${search}` : ''}`;
}

/** The editor at its address, in its layout; `addressNow()` says where it has gone since. */
export function renderProblemEditor(options: RenderOptions = {}) {
  const { role = 'MEMBER', delay = 60_000, user } = options;
  return renderModule(
    <ProblemEditorLayout delay={delay}>
      <ProblemEditorPage />
    </ProblemEditorLayout>,
    {
      entry: editorAddress(options),
      path: '/problem-editor',
      user: user === undefined ? ACCOUNT : user,
      tree: [orgNode('isa-demo', { name: 'ISA Demo Group', effective_role: role })],
      routes: { '/problems/:org/:problem': <p>problem page</p>, '*': <p>elsewhere</p> },
    }
  );
}

/** Where the router of a rendered editor is: path and query. */
export const whereOf = () => addressNow();

/** Render the editor and wait until its package is on screen. */
export async function openProblemEditor(options: RenderOptions = {}) {
  const view = renderProblemEditor(options);
  await screen.findByRole('tablist', { name: 'Editor panes' });
  return view;
}

/** Show one of the editor's visual panes. */
export function showPane(name: 'Workflow' | 'Candidates' | 'Rules' | 'Forms' | 'BPMN') {
  const visual = screen.getByRole('button', { name: 'Visual' });
  if (visual.getAttribute('aria-pressed') !== 'true') fireEvent.click(visual);
  fireEvent.click(
    within(screen.getByRole('tablist', { name: 'Editor panes' })).getByRole('tab', { name })
  );
}

/** Show the package's files (Code mode). */
export function showCode() {
  fireEvent.click(screen.getByRole('button', { name: 'Code' }));
}

/** Run an entry of the File menu of the header (Undo, Redo, Reset, Open a template…). */
export function fileMenu(entry: string) {
  fireEvent.click(screen.getByRole('button', { name: 'File' }));
  fireEvent.click(
    within(screen.getByRole('menu', { name: 'File' })).getByRole('menuitem', { name: entry })
  );
}

/** Check the package now, without waiting for the delay. */
export const checkNow = () => fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
