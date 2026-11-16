import type { CompletionSource } from '@codemirror/autocomplete';
import { CodeEditor } from '../../../../components/CodeEditor/CodeEditor';
import type { Located } from '../../../core/diagnostics/located';
import { ProblemsPanel } from '../../../core/components/problems-panel/ProblemsPanel';

interface CodePaneProps {
  text: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  diagnostics: readonly Located[];
  completions: CompletionSource;
  selection: { anchor: number; head?: number } | undefined;
  onSelect: (diagnostic: Located) => void;
  /** The Problems panel under the code; on a phone it is a tab of its own. */
  withProblems: boolean;
}

/** The code of the draft, with the gateway's findings marked in it and listed below, and completion while typing. */
export function CodePane({
  text,
  onChange,
  readOnly,
  diagnostics,
  completions,
  selection,
  onSelect,
  withProblems,
}: CodePaneProps) {
  return (
    <div className="ce-code">
      <CodeEditor
        value={text}
        onChange={onChange}
        readOnly={readOnly}
        language="yaml"
        ariaLabel="composition.yaml source"
        minHeight="360px"
        maxHeight="70vh"
        diagnostics={diagnostics}
        completions={completions}
        selection={selection}
      />
      {withProblems && <ProblemsPanel diagnostics={diagnostics} onSelect={onSelect} />}
    </div>
  );
}
