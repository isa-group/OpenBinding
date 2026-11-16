import { describe, expect, it } from 'vitest';
import type { BimValidateResponse } from '../../api/bim';
import type { CompositionVersionView, ProblemFacts } from '../../modules/core/api/types';
import { candidateMatrix } from './candidateMatrix';
import { workflowGraph } from './workflowGraph';

// §10 F2: the renderer and the BIM editor draw the same graph and the same matrix. The renderer reads a stored compilation's
// facts and a version's document; the editor reads the facts of a drafted package (`validate?include=facts`). The fixtures are
// the gateway's own answers (src/test/fixtures/core, written by dump_frontend_fixtures.py).
const all = import.meta.glob('../../test/fixtures/core/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const fixture = <T>(name: string, kind: string) => {
  const found = all[`../../test/fixtures/core/${name}.${kind}.json`];
  if (!found) throw new Error(`missing fixture ${name}.${kind}.json`);
  return structuredClone(found) as T;
};
const NAMES = ['simple-seq', 'fms', 'json-complete', 'ambiguous'];

describe('the same graph and the same matrix', () => {
  it('has every fixture package', () => {
    expect(Object.keys(all).filter(path => path.endsWith('.facts.json'))).toHaveLength(
      NAMES.length
    );
  });

  describe.each(NAMES)('%s', name => {
    const facts = fixture<ProblemFacts>(name, 'facts');
    const validate = fixture<BimValidateResponse>(name, 'validate');
    const version = fixture<CompositionVersionView>(name, 'version');
    const current = version.evaluations.find(evaluation => evaluation.current);

    it('draws the stored facts and the facts of the drafted package as the same matrix', () => {
      expect(validate.facts).toBeDefined();
      expect(candidateMatrix(facts)).toEqual(candidateMatrix(validate.facts as ProblemFacts));
    });

    it('draws the problem’s workflow and the derived document’s workflow as the same graph', () => {
      expect(workflowGraph(facts.workflow)).toEqual(workflowGraph(version.document?.workflow));
      expect(workflowGraph(facts.workflow).tasks.every(task => task.length > 0)).toBe(true);
    });

    it('selects, for every task of the current binding, a candidate of that task written as the document writes it', () => {
      expect(current?.binding).toBeTruthy();
      const binding = current?.binding as Record<string, string>;
      const document = version.document as { binding: Record<string, { candidate?: string }> };
      const matrix = candidateMatrix(facts, { selection: binding });
      for (const [task, key] of Object.entries(binding)) {
        const row = matrix.rows.find(entry => entry.task === task);
        const chosen = row?.candidates.find(candidate => candidate.key === key);
        expect(chosen, `${task} → ${key}`).toBeDefined();
        expect(chosen?.selected).toBe(true);
        expect(chosen?.written).toBe(document.binding[task].candidate);
      }
    });
  });
});
