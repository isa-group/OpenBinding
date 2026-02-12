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
}

export function CodeEditor({ 
  value, 
  onChange, 
  readOnly = false, 
  placeholder,
  minHeight = '200px',
  maxHeight = '600px'
}: CodeEditorProps) {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  return (
    <div className="code-editor-wrapper">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={[json(), EditorView.lineWrapping]}
        theme={isDark ? 'dark' : 'light'}
        readOnly={readOnly}
        placeholder={placeholder}
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
