import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import './CodeEditor.css';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  minHeight?: string;
  maxHeight?: string;
  language?: 'json' | 'xml' | 'cel' | 'text';
  ariaLabel?: string;
  selection?: { anchor: number; head?: number };
}

export function CodeEditor({ 
  value, 
  onChange, 
  readOnly = false, 
  placeholder,
  minHeight = '200px',
  maxHeight = '600px',
  language = 'json',
  ariaLabel = 'Source editor',
  selection,
}: CodeEditorProps) {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  return (
    <div className="code-editor-wrapper">
      <CodeMirror
        key={`${ariaLabel}:${selection?.anchor ?? ''}:${selection?.head ?? ''}`}
        value={value}
        onChange={onChange}
        extensions={[...(language === 'json' ? [json()] : []), EditorView.lineWrapping]}
        theme={isDark ? 'dark' : 'light'}
        readOnly={readOnly}
        placeholder={placeholder}
        aria-label={ariaLabel}
        selection={selection ? {
          anchor: Math.max(0, Math.min(value.length, selection.anchor)),
          head: Math.max(0, Math.min(value.length, selection.head ?? selection.anchor)),
        } : undefined}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightActiveLine: true,
          foldGutter: true,
          dropCursor: true,
          indentOnInput: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: true,
          highlightSelectionMatches: true,
        }}
        style={{
          minHeight,
          maxHeight,
          fontSize: '14px',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          overflow: 'auto',
        }}
      />
    </div>
  );
}
