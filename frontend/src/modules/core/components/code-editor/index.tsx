// Pattern only, after SPHERE frontend/src/modules/pricing-editor/pages/pricing2yaml-editor/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in
// THIRD_PARTY_NOTICES.md. The code editor of OpenBinding's editors: Monaco through @monaco-editor/react with SPHERE's two
// themes and options, but bundled (./monaco.ts) instead of loaded from a CDN. The textarea Monaco draws is named after the
// file, for assistive technology and for tests.

import Editor, { type EditorProps, type OnMount } from '@monaco-editor/react';
import { useCallback } from 'react';
import './monaco';

export type { OnMount };

interface CodeEditorProps extends Omit<EditorProps, 'theme'> {
  /** What the editor holds, for the textarea's name ("composition.yaml source"). */
  ariaLabel: string;
  /** `dark` in the editors' dark layout (SPHERE's GitHub Dark), `light` elsewhere (Textmate). */
  tone?: 'light' | 'dark';
}

export default function CodeEditor({
  ariaLabel,
  tone = 'dark',
  options,
  onMount,
  ...props
}: CodeEditorProps) {
  const mounted = useCallback<OnMount>(
    (editor, instance) => {
      editor.getDomNode()?.querySelector('textarea')?.setAttribute('aria-label', ariaLabel);
      onMount?.(editor, instance);
    },
    [ariaLabel, onMount]
  );
  return (
    <Editor
      {...props}
      theme={tone === 'dark' ? 'github-dark' : 'textmate'}
      onMount={mounted}
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        ariaLabel,
        ...options,
      }}
    />
  );
}
