import { counts } from '../../core/diagnostics/located';
import type { ProblemEditorState } from '../hooks/useProblemEditor';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export type CheckTone = 'valid' | 'invalid' | 'busy' | 'waiting' | 'none';

/** What the live check is doing, in words, and its tone. */
export function checkStatus(editor: ProblemEditorState): { text: string; tone: CheckTone } {
  if (editor.pausedMessage) return { text: editor.pausedMessage, tone: 'waiting' };
  if (editor.unparsed.length)
    return { text: `Waiting for valid JSON in ${editor.unparsed.join(', ')}`, tone: 'waiting' };
  if (editor.checking) return { text: 'Checking…', tone: 'busy' };
  if (editor.upToDate && editor.last) {
    if (editor.last.valid) return { text: 'Valid package', tone: 'valid' };
    const errors = counts(editor.diagnostics).error;
    return { text: `Not valid · ${plural(errors, 'problem', 'problems')}`, tone: 'invalid' };
  }
  return { text: editor.checkIssue ? 'Not checked' : '', tone: 'none' };
}
