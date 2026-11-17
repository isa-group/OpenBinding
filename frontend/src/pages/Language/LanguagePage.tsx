import type { ReactNode } from 'react';
import { ArrowUpRight, Download, Pencil } from 'lucide-react';
import { Link } from 'react-router-dom';
import { SourceView } from '../../components/rendering/SourceView';
import { Badge } from '../../modules/core/components/badge';
import { PageHeader } from '../../modules/core/components/page-header';
import { config } from '../../config';
import examples from '../../content/composition2yaml-examples.json';
import { compositionFragment } from '../../modules/core/utils/sphere/composition-fragment';
import { editorPath } from '../../routes/paths/compositions';
import './LanguagePage.css';

/** The normative specification, on GitHub. */
export const SPECIFICATION_URL =
  'https://github.com/isa-group/OpenBinding/blob/main/docs/COMPOSITION2YAML.md';
/** The JSON Schema of the latest syntax version, as the gateway serves it. */
export const SCHEMA_URL = `${config.apiBaseUrl}/v1/compositions/schema`;

/** One example of the reference: `expect` is `valid` (no finding at all) or the code that refuses it (the gateway's test holds both). */
export interface LanguageExample {
  name: string;
  description: string;
  yaml: string;
  expect: string;
}

export const SECTIONS: readonly LanguageExample[] = examples.sections;

const NOT_IN_THE_LANGUAGE: readonly { title: string; text: string }[] = [
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

/** `backticks` in the content are code. */
function withCode(text: string): ReactNode[] {
  return text
    .split('`')
    .map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part));
}

/**
 * Language (`pub-language`, `/language`): the Composition2Yaml reference, with an example per section that the gateway's own tests
 * read, each one opening in the composition editor (`/editor`) through a `#composition=` link, which never reaches a server; the
 * specification, the JSON Schema, the versions of the language and what is not in it.
 */
export function LanguagePage() {
  return (
    <div className="lang-page">
      <PageHeader
        eyebrow="Language"
        title="Composition2Yaml"
        lede="The document of a final composition: the candidate chosen for each task of a workflow, where each one came from, and the values the choice yields. The alternatives it was chosen from live in a BIM problem, which a composition may link to have its values computed and verified."
        actions={
          <>
            <Link className="ui-action is-primary is-md" to={editorPath()}>
              <Pencil aria-hidden="true" /> Write in the editor
            </Link>
            <a
              className="ui-action is-secondary is-md"
              href={SPECIFICATION_URL}
              target="_blank"
              rel="noreferrer"
            >
              Read the specification <ArrowUpRight aria-hidden="true" />
            </a>
            <a
              className="ui-action is-secondary is-md"
              href={SCHEMA_URL}
              target="_blank"
              rel="noreferrer"
              download="composition.schema.json"
            >
              <Download aria-hidden="true" /> Download the schema
            </a>
          </>
        }
      />

      <section className="lang-section" aria-labelledby="lang-versions-title">
        <div className="lang-section-head">
          <h2 id="lang-versions-title">Versions of the language</h2>
        </div>
        <ul className="lang-points">
          <li>
            Every document starts with <code>syntaxVersion: &quot;1.0&quot;</code>, quoted: the
            version of the language, not of the document. The document’s own label is{' '}
            <code>version</code>, a semantic version such as <code>1.3.0</code>.
          </li>
          <li>
            A minor version (<code>1.x</code>) only adds optional keys, so every <code>1.0</code>{' '}
            document keeps its meaning. A major version changes the meaning of something already
            there.
          </li>
          <li>A sealed version keeps the syntax version it was sealed with.</li>
          <li>
            Composition2Yaml is versioned on its own: its syntax version never follows a BIM or
            toolchain release.
          </li>
        </ul>
      </section>

      <section className="lang-section" aria-labelledby="lang-examples-title">
        <div className="lang-section-head">
          <h2 id="lang-examples-title">The language by example</h2>
          <p>
            Each example is read by the gateway’s tests, so what it says about itself holds. Open
            any of them in the composition editor.
          </p>
        </div>
        <ol className="lang-examples">
          {SECTIONS.map(example => (
            <li key={example.name}>
              <article
                className="lang-example"
                aria-labelledby={`lang-example-${slugOf(example.name)}`}
              >
                <div className="lang-example-head">
                  <h3 id={`lang-example-${slugOf(example.name)}`}>{example.name}</h3>
                  {example.expect === 'valid' ? (
                    <Badge variant="success">Valid</Badge>
                  ) : (
                    <Badge variant="error">
                      Refused: <code>{example.expect}</code>
                    </Badge>
                  )}
                </div>
                <p>{withCode(example.description)}</p>
                <SourceView
                  source={example.yaml}
                  label={`${example.name} source`}
                  language="yaml"
                />
                <Link
                  className="ui-action is-secondary is-sm"
                  to={`${editorPath()}${compositionFragment(example.yaml)}`}
                  aria-label={`Open “${example.name}” in the editor`}
                >
                  <Pencil aria-hidden="true" />
                  Open in the editor
                </Link>
              </article>
            </li>
          ))}
        </ol>
      </section>

      <section className="lang-section" aria-labelledby="lang-outside-title">
        <div className="lang-section-head">
          <h2 id="lang-outside-title">What is not in the language</h2>
        </div>
        <dl className="lang-outside">
          {NOT_IN_THE_LANGUAGE.map(item => (
            <div key={item.title}>
              <dt>{item.title}</dt>
              <dd>{item.text}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
