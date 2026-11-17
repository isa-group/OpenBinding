// Adapted from SPHERE frontend/src/modules/pricing-editor/hooks/useEditorValue.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the problem editor's context, with no default value, so a component used outside its layout fails loudly.

import { useContext } from 'react';
import {
  ProblemEditorContext,
  type ProblemEditorContextValue,
} from '../contexts/problemEditorContext';

export function useProblemEditorValue(): ProblemEditorContextValue {
  const context = useContext(ProblemEditorContext);
  if (!context) throw new Error('useProblemEditorValue is used inside the problem editor layout.');
  return context;
}
