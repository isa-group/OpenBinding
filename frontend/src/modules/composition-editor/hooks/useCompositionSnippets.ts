// Adapted from SPHERE frontend/src/modules/pricing-editor/hooks/usePricing2YamlSnippets.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: Composition2Yaml snippets; the Monaco namespace is the bundled one's type; the callback is kept in a ref updated
// in an effect, as React 19 asks.

import type * as Monaco from 'monaco-editor';
import { useCallback, useEffect, useRef } from 'react';
import {
  insertSnippet,
  registerSnippetActions,
  registerSnippetCompletions,
  registerTemplatesMenuAction,
  type CompositionSnippet,
} from '../services/snippets';

/**
 * Makes the Composition2Yaml templates reachable from the editor: as YAML completions, as commands in the context menu,
 * through the `Ctrl/Cmd + K` shortcut that opens the templates menu, and as a callback for the menu itself.
 */
export function useCompositionSnippets(
  editor: Monaco.editor.IStandaloneCodeEditor | null,
  monacoInstance: typeof Monaco | null,
  snippets: readonly CompositionSnippet[],
  onOpenTemplates: () => void
): (snippet: CompositionSnippet) => void {
  // Kept in a ref so a new callback identity does not re-register the command.
  const openTemplatesRef = useRef(onOpenTemplates);
  useEffect(() => {
    openTemplatesRef.current = onOpenTemplates;
  }, [onOpenTemplates]);

  useEffect(() => {
    if (!monacoInstance) return undefined;
    const disposable = registerSnippetCompletions(monacoInstance, snippets);
    // Registration is global to the language, so it has to be undone on unmount or every remount would add another copy
    // of every suggestion.
    return () => disposable.dispose();
  }, [monacoInstance, snippets]);

  useEffect(() => {
    if (!editor || !monacoInstance) return undefined;
    const disposables = [
      ...registerSnippetActions(editor, snippets),
      registerTemplatesMenuAction(editor, monacoInstance, () => openTemplatesRef.current()),
    ];
    return () => disposables.forEach(disposable => disposable.dispose());
  }, [editor, monacoInstance, snippets]);

  return useCallback(
    (snippet: CompositionSnippet) => {
      if (editor) insertSnippet(editor, snippet);
    },
    [editor]
  );
}
