// Adapted from SPHERE frontend/src/modules/pricing-editor/hooks/useEditorValue.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the context has no default value, so a component used outside the editor layout fails loudly.

import { useContext } from 'react';
import {
  EditorValueContext,
  type EditorValueContextInterface,
} from '../contexts/editorValueContext';

export function useEditorValue(): EditorValueContextInterface {
  const context = useContext(EditorValueContext);
  if (!context) throw new Error('useEditorValue is used inside the editor layout.');
  return context;
}
