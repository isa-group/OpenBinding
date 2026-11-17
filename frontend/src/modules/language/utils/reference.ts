import { config } from '../../../config';
import examples from '../../../content/composition2yaml-examples.json';

/** The normative specification, on GitHub. */
export const SPECIFICATION_URL =
  'https://github.com/isa-group/OpenBinding/blob/main/docs/COMPOSITION2YAML.md';
/** The JSON Schema of the latest syntax version, as the gateway serves it (`GET /v1/compositions/schema`). */
export const SCHEMA_URL = `${config.apiBaseUrl}/v1/compositions/schema`;

/** One example of the reference: `expect` is `valid` (no finding at all) or the code that refuses it (the gateway's test holds both). */
export interface LanguageExample {
  name: string;
  description: string;
  yaml: string;
  expect: string;
}

/** The examples, one per section of the language; the gateway's tests read the same file (`test_the_spec_examples.py`). */
export const SECTIONS: readonly LanguageExample[] = examples.sections;

export const NOT_IN_THE_LANGUAGE: readonly { title: string; text: string }[] = [
  {
    title: 'The alternatives',
    text: 'Candidates to choose from, constraints, objectives, demand and its variants are the BIM problem’s. A different demand is a different problem revision.',
  },
  {
    title: 'Optimisation settings',
    text: 'Weights and scalarisation belong to a run preset, never to a document.',
  },
  {
    title: 'The offering’s content',
    text: 'Plans, prices and limits stay in SPHERE or in the Pricing2Yaml file. The document holds one reference, without a version.',
  },
  {
    title: 'Presentation',
    text: 'Sections, highlights, labels and layout are decided by the screen that renders a composition, never written in the document.',
  },
  {
    title: 'Identity and visibility',
    text: 'Who owns a composition, who may read it and whether it is public belong to the platform, not to the document.',
  },
];

/** The anchor of a section of the page. */
export const sectionId = (name: string) =>
  `lang-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
