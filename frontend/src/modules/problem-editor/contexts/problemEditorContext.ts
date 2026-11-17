// Adapted from SPHERE frontend/src/modules/pricing-editor/contexts/editorValueContext.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the value is the problem editor's state (useProblemEditor: the package's files and their history, the live
// check, the facts and the save) instead of a pricing's text; the modes are Visual (the panes) and Code (the files); the
// context also says what the address opened (an organization's problem version) and the last save, whose notice the page
// shows.

import { createContext } from 'react';
import type { ProblemEditorState, SaveOutcome } from '../hooks/useProblemEditor';

export type ProblemEditorMode = 'visual' | 'code';

/** A save the gateway made (or found already made): the organization it went to and what it answered. */
export interface SavedPackage {
  org: string;
  outcome: Exclude<SaveOutcome, { kind: 'refused' }>;
}

export interface ProblemEditorContextValue {
  editor: ProblemEditorState;
  mode: ProblemEditorMode;
  setMode: (mode: ProblemEditorMode) => void;
  /** The organization and problem the address opened (`?org=&problem=`), and the problem's name once read. */
  org: string | null;
  problem: string | null;
  problemName: string | null;
  /** The composition version highlighted on the package (`&composition=&compositionVersion=`). */
  composition: string | null;
  compositionVersion: string | null;
  saved: SavedPackage | null;
}

export const ProblemEditorContext = createContext<ProblemEditorContextValue | null>(null);
