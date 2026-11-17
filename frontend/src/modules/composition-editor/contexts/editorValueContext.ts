// Adapted from SPHERE frontend/src/modules/pricing-editor/contexts/editorValueContext.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the value is OpenBinding's editor state (useCompositionEditor: the draft and its history, the gateway's lint and
// check, completion facts, the visual round trip and the seal) instead of a bare string and a pending visual draft: the
// visual pane writes each change to the text at once, so there is no unsaved visual draft to save or discard. The source is
// a version of a composition.

import { createContext } from 'react';
import type { CompositionEditorState } from '../hooks/useCompositionEditor';

export type EditorMode = 'code' | 'visual';

/** The composition version the editor was opened from (`?source=org/slug&version=`). */
export interface EditorSource {
  org: string;
  slug: string;
  name: string;
  kind: string;
  /** The version's label; null for a composition with no version yet. */
  version: string | null;
}

export interface EditorValueContextInterface {
  editor: CompositionEditorState;
  editorMode: EditorMode;
  setEditorMode: (mode: EditorMode) => void;
  source: EditorSource | null;
  /** The organization `?org=` names: where a new composition is published by default. */
  organization: string | null;
}

export const EditorValueContext = createContext<EditorValueContextInterface | null>(null);
