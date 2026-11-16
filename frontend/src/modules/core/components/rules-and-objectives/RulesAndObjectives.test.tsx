import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProblemFacts } from '../../api/types';
import completeFacts from '../../../../test/fixtures/core/json-complete.facts.json';
import simpleFacts from '../../../../test/fixtures/core/simple-seq.facts.json';
import { RulesAndObjectives } from './RulesAndObjectives';

const path = (...segments: string[]) => ({ kind: 'path', segments });
const literal = (value: unknown) => ({ kind: 'literal', value });

/** The facts of a small package with one rule that must hold, one that should, two criteria and the cost of breaking the soft rule. */
function checkoutFacts(): ProblemFacts {
  return {
    ...(structuredClone(simpleFacts) as ProblemFacts),
    constraints: [
      {
        id: 'rules/sla-latency',
        enforcement: 'hard',
        when: literal(true),
        penalty: null,
        expression: {
          kind: 'compare',
          op: 'lte',
          left: path('features', 'latency'),
          right: literal(600),
        },
        origin: { resource: 'rules', path: 'rules.json', pointer: '/spec/constraints/sla-latency' },
      },
      {
        id: 'rules/sla-availability',
        enforcement: 'soft',
        when: literal(true),
        penalty: literal(5),
        expression: {
          kind: 'compare',
          op: 'gte',
          left: path('features', 'availability'),
          right: literal(99.9),
        },
        origin: {
          resource: 'rules',
          path: 'rules.json',
          pointer: '/spec/constraints/sla-availability',
        },
      },
    ],
    objectives: {
      criteria: [
        { id: 'cost', feature: { resource: 'app', id: 'cost' }, direction: 'minimize' },
        {
          id: 'latency',
          feature: { resource: 'app', id: 'latency' },
          direction: 'minimize',
          normalize: { min: 0, max: 1000, clamp: true },
        },
      ],
      penalties: [{ constraint: { resource: 'rules', id: 'sla-availability' }, weight: 5 }],
    },
  };
}

const rules = () => screen.getByRole('list', { name: 'Rules of this version' });
const ruleOf = (id: string) =>
  within(rules())
    .getAllByRole('listitem')
    .find(item => item.textContent?.includes(id)) as HTMLElement;

describe('RulesAndObjectives', () => {
  it('writes each rule with its enforcement, its formula, its penalty and the file the package writes it in', () => {
    render(<RulesAndObjectives facts={checkoutFacts()} />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Rules and objectives' })
    ).toBeInTheDocument();
    const hard = ruleOf('rules/sla-latency');
    expect(within(hard).getByText('Must')).toBeInTheDocument();
    expect(hard).toHaveTextContent('features.latency ≤ 600');
    expect(hard).toHaveTextContent('hard: a binding that breaks it is invalid');
    expect(hard).toHaveTextContent('written in rules.json at /spec/constraints/sla-latency');
    expect(hard).not.toHaveTextContent('penalty');

    const soft = ruleOf('rules/sla-availability');
    expect(within(soft).getByText('Should')).toBeInTheDocument();
    expect(soft).toHaveTextContent('features.availability ≥ 99.9');
    expect(soft).toHaveTextContent('penalty 5 if broken');
    expect(soft).toHaveTextContent('soft: a binding may break it, at a cost');
  });

  it('says when a rule applies only when its guard holds', () => {
    const facts = checkoutFacts();
    facts.constraints[0] = {
      ...facts.constraints[0],
      when: {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'path', segments: ['features', 'cost'] },
        right: { kind: 'literal', value: 1 },
      },
    };
    render(<RulesAndObjectives facts={facts} />);

    expect(ruleOf('rules/sla-latency')).toHaveTextContent('when features.cost > 1');
  });

  it('lists the criteria with their direction and scale, and what breaking a soft rule costs', () => {
    render(<RulesAndObjectives facts={checkoutFacts()} />);

    const objectives = screen.getByRole('region', { name: 'Objectives' });
    const criteria = within(objectives).getByRole('list', { name: 'Criteria to optimize' });
    expect(
      within(criteria)
        .getAllByRole('listitem')
        .map(item => item.textContent)
    ).toEqual(['costlower is better', 'latencylower is better · scaled 0–1000']);
    const costs = within(objectives).getByRole('list', { name: 'What breaking a soft rule costs' });
    expect(costs).toHaveTextContent('Breaking rules/sla-availabilitycosts weight 5');
  });

  it('reads the facts the gateway produces for a package', () => {
    render(<RulesAndObjectives facts={completeFacts as ProblemFacts} />);

    expect(within(rules()).getAllByRole('listitem')).toHaveLength(
      (completeFacts as ProblemFacts).constraints.length
    );
    expect(ruleOf('constraints/carbon_budget')).toHaveTextContent('features.carbon ≤ 30');
    expect(ruleOf('constraints/carbon_budget')).toHaveTextContent(
      'written in constraints.json at /spec/constraints/carbon_budget'
    );
    expect(
      within(screen.getByRole('list', { name: 'Criteria to optimize' }))
        .getByText('trust')
        .closest('li')
    ).toHaveTextContent('higher is better · scaled 0–1');
    expect(
      screen.queryByRole('list', { name: 'What breaking a soft rule costs' })
    ).not.toBeInTheDocument();
  });

  it('says a version declares no rules', () => {
    render(<RulesAndObjectives facts={simpleFacts as ProblemFacts} />);

    expect(screen.getByRole('region', { name: 'Rules' })).toHaveTextContent(
      'This version declares no rules.'
    );
    expect(screen.getByRole('list', { name: 'Criteria to optimize' })).toHaveTextContent('latency');
  });

  it('says a version declares no criteria, and does not invent a direction', () => {
    const facts = checkoutFacts();
    render(
      <RulesAndObjectives facts={{ ...facts, objectives: { criteria: [], penalties: [] } }} />
    );
    expect(screen.getByRole('region', { name: 'Objectives' })).toHaveTextContent(
      'This version declares no criteria to optimize.'
    );
  });

  it('words the package of an editor, and opens a rule where the package writes it', () => {
    const open = vi.fn();
    render(<RulesAndObjectives facts={checkoutFacts()} subject="package" onOpenOrigin={open} />);

    const rules = screen.getByRole('list', { name: 'Rules of this package' });
    fireEvent.click(
      within(rules).getByRole('button', {
        name: 'Open rules/sla-availability in rules.json at /spec/constraints/sla-availability',
      })
    );
    expect(open).toHaveBeenCalledWith({
      resource: 'rules',
      path: 'rules.json',
      pointer: '/spec/constraints/sla-availability',
    });
    expect(screen.getByRole('region', { name: 'Objectives' })).toHaveTextContent(
      'is chosen when a saved version is run'
    );
  });

  it('says a package declares no rules', () => {
    render(<RulesAndObjectives facts={simpleFacts as ProblemFacts} subject="package" />);
    expect(screen.getByRole('region', { name: 'Rules' })).toHaveTextContent(
      'This package declares no rules.'
    );
  });
});
