import { describe, expect, it } from 'vitest';
import type { ProblemFacts } from '../../shared/api/types';
import ambiguous from '../../test/fixtures/core/ambiguous.facts.json';
import fms from '../../test/fixtures/core/fms.facts.json';
import jsonComplete from '../../test/fixtures/core/json-complete.facts.json';
import simpleSeq from '../../test/fixtures/core/simple-seq.facts.json';
import { PROBLEM_FACTS, S1 } from '../../test/fixtures/jobs';
import { bindingFeaturesOf, bindingRowsOf } from './bindingTableModel';
import { runProblemOf } from './runProblem';
import { unitsOf } from './runResultModel';

const FIXTURES: Record<string, ProblemFacts> = {
  ambiguous: ambiguous as ProblemFacts,
  fms: fms as ProblemFacts,
  'json-complete': jsonComplete as ProblemFacts,
  'simple-seq': simpleSeq as ProblemFacts,
};

describe('runProblemOf', () => {
  it.each(Object.entries(FIXTURES))(
    'places the facts of %s into the run models’ shapes',
    (_name, facts) => {
      const problem = runProblemOf(facts);
      expect(problem.tasks.map(task => task.id)).toEqual(facts.tasks.map(task => task.id));
      for (const [index, task] of facts.tasks.entries()) {
        expect(problem.tasks[index].candidates.map(candidate => candidate.name)).toEqual(
          task.eligible.map(entry => entry.written)
        );
      }
      expect(bindingFeaturesOf(problem)).toEqual(
        facts.features.map(feature => ({ name: feature.id, unit: feature.unit }))
      );
      expect(problem.criteria.map(criterion => criterion.id)).toEqual(
        facts.objectives.criteria.map(criterion => criterion.id)
      );
    }
  );

  it('gives a local task no candidate, and keeps each candidate’s values and provider as the facts write them', () => {
    const problem = runProblemOf(FIXTURES.fms);
    expect(problem.tasks.find(task => task.id === 'node_classic_routing')?.candidates).toEqual([]);
    expect(problem.tasks[0].candidates[0]).toEqual({
      id: 'cand_t1_aws',
      name: 'cand_t1_aws',
      provider: 'amazon',
      features: {
        availability: 0.9995,
        cost: 220,
        execution_time: 210,
        reliability: 0.9975,
        security: 5,
      },
    });
    expect(problem.criteria.find(criterion => criterion.id === 'availability')?.direction).toBe(
      'maximize'
    );
  });

  it('names an ambiguous candidate as the problem writes it for its task', () => {
    const names = runProblemOf(FIXTURES.ambiguous).tasks[0].candidates.map(
      candidate => candidate.name
    );
    expect(names).toEqual(['catalog/c1a', 'c1b', 'other/c1a']);
  });

  it('reads the binding table of a run with the same names and values as before', () => {
    const problem = runProblemOf(PROBLEM_FACTS);
    expect(bindingRowsOf(S1.decision.binding, problem)).toEqual([
      {
        task: 't1',
        taskName: 't1',
        candidate: 'c1',
        candidateName: 'c1',
        provider: 'stripe',
        values: { latency: 120, cost: 4 },
      },
      {
        task: 't2',
        taskName: 't2',
        candidate: 'c3',
        candidateName: 'c3',
        provider: 'dhl',
        values: { latency: 200, cost: 3 },
      },
      {
        task: 't3',
        taskName: 't3',
        candidate: 'c4',
        candidateName: 'c4',
        provider: 'twilio',
        values: { latency: 100, cost: 2.5 },
      },
    ]);
    expect(unitsOf(problem)).toEqual({ latency: 'ms', cost: 'EUR' });
  });
});
