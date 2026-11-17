// Pattern only, after SPHERE frontend/src/modules/pricing-editor/pages/pricing2yaml-editor/templates/snippets.ts (revision
// 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full
// text is in THIRD_PARTY_NOTICES.md. The templates of the Composition2Yaml editor: a task's binding, a value, the problem
// link and the offering as blocks, and the starter and the language reference's valid examples as whole documents.

import examples from '../../../../content/composition2yaml-examples.json';
import type { CompositionSnippet } from './types';

/** A document of the reference as a snippet body: written as it is, with no tab stops. */
const literal = (yaml: string) => yaml.replaceAll('\\', '\\\\').replaceAll('$', '\\$');

const DOCUMENTS: CompositionSnippet[] = [
  {
    id: 'starter',
    label: 'Starter',
    prefix: 'composition',
    detail: 'Two tasks, one bound in-house',
    documentation:
      'The smallest composition worth starting from: a workflow, its binding and a value.',
    kind: 'document',
    body: literal(examples.starter),
  },
  ...examples.sections
    .filter(section => section.expect === 'valid')
    .map((section, index): CompositionSnippet => ({
      id: `example-${index}`,
      label: section.name,
      prefix: `example${index + 1}`,
      detail: 'From the language reference',
      documentation: section.description,
      kind: 'document',
      body: literal(section.yaml),
    })),
];

/**
 * The templates the editor offers, by typing their prefix or through the templates menu. Each block is one entry of the key it
 * lands in; whether the document is valid stays the gateway's answer.
 */
export const COMPOSITION2YAML_SNIPPETS: readonly CompositionSnippet[] = [
  {
    id: 'candidate',
    label: 'Task bound to a candidate',
    prefix: 'candidate',
    detail: 'binding: a task and the candidate chosen for it',
    documentation: 'Every task of the workflow has exactly one binding entry.',
    kind: 'block',
    section: 'binding',
    body: '${1:task}: {candidate: ${2:candidate}}',
  },
  {
    id: 'local',
    label: 'Task done in-house',
    prefix: 'local',
    detail: 'binding: a task no provider does',
    documentation: 'A local task is done by the composition itself and adds nothing to its values.',
    kind: 'block',
    section: 'binding',
    body: '${1:task}: {local: true}',
  },
  {
    id: 'from-sphere',
    label: 'Candidate from a SPHERE pricing',
    prefix: 'sphere',
    detail: 'binding: a candidate with its provenance',
    documentation:
      'Where the candidate comes from: a pricing in SPHERE, its version, plan and add-ons.',
    kind: 'block',
    section: 'binding',
    body: '${1:task}: {candidate: ${2:candidate}, from: {sphere: ${3:organization/pricing}, version: ${4:v1}, plan: ${5:Pro}}}',
  },
  {
    id: 'value',
    label: 'Value with a unit',
    prefix: 'value',
    detail: 'values: a number and its unit',
    documentation: 'A global value the binding yields, with the unit it is written in.',
    kind: 'block',
    section: 'values',
    body: '${1:cost}: {value: ${2:10}, unit: ${3:EUR/month}}',
  },
  {
    id: 'number',
    label: 'Dimensionless value',
    prefix: 'number',
    detail: 'values: a bare number',
    documentation: 'A bare number is dimensionless (an availability, a ratio).',
    kind: 'block',
    section: 'values',
    body: '${1:availability}: ${2:0.999}',
  },
  {
    id: 'problem',
    label: 'Linked problem',
    prefix: 'problem',
    detail: 'problem: the BIM problem revision chosen in',
    documentation:
      'With a linked problem, the gateway computes and verifies the values when a version is sealed.',
    kind: 'block',
    section: 'problem',
    body: 'ref: ${1:organization}/problems/${2:problem}@${3:1}\ncompilation: ${4:sha256-}',
  },
  {
    id: 'offering',
    label: 'Offering in SPHERE',
    prefix: 'offering',
    detail: 'offering: the composition’s own pricing',
    documentation: 'The composition’s own pricing, by reference only: a pricing in SPHERE.',
    kind: 'block',
    section: 'offering',
    body: 'sphere: ${1:organization/pricing}',
  },
  ...DOCUMENTS,
];
