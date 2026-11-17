// Pattern only, after SPHERE frontend/src/modules/settings/pages/SettingsPage.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE has no in-app language reference (it links to its docs site); this page follows its settings layout: a
// sticky section index beside the content at `lg` and a select above it below, with one example per section of
// Composition2Yaml in the composition module's YamlSourcePanel (SPHERE's pricing yaml-source-panel). The index links are
// anchors, and the entry of the section in view is marked.

import { useEffect, useState, type ReactNode } from 'react';
import { Helmet } from 'react-helmet-async';
import { MdDownload, MdEdit, MdNorthEast } from 'react-icons/md';
import { Link } from 'react-router-dom';
import { editorPath } from '../../../../routes/paths/compositions';
import YamlSourcePanel from '../../../composition/components/yaml-source-panel';
import { Action } from '../../../core/components/action-button';
import { Badge } from '../../../core/components/badge';
import { compositionFragment } from '../../../core/utils/sphere/composition-fragment';
import {
  NOT_IN_THE_LANGUAGE,
  SCHEMA_URL,
  SECTIONS,
  SPECIFICATION_URL,
  sectionId,
} from '../../utils/reference';

interface IndexEntry {
  id: string;
  label: string;
  /** An example under "The language by example". */
  nested?: boolean;
}

const VERSIONS_ID = 'lang-versions';
const EXAMPLES_ID = 'lang-examples';
const OUTSIDE_ID = 'lang-outside';

const INDEX: readonly IndexEntry[] = [
  { id: VERSIONS_ID, label: 'Versions of the language' },
  { id: EXAMPLES_ID, label: 'The language by example' },
  ...SECTIONS.map(example => ({ id: sectionId(example.name), label: example.name, nested: true })),
  { id: OUTSIDE_ID, label: 'What is not in the language' },
];

const INDEX_IDS = INDEX.map(entry => entry.id);

const CODE = 'rounded bg-tp-surface px-1 font-mono text-[0.9em] text-tp-ink';

const OUTLINE =
  'inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-tp-hairline-strong bg-tp-canvas px-4 text-sm font-medium whitespace-nowrap text-tp-ink transition-colors hover:border-tp-stone hover:bg-tp-surface';

/** `backticks` in the content are code. */
function withCode(text: string): ReactNode[] {
  return text.split('`').map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className={CODE}>
        {part}
      </code>
    ) : (
      part
    )
  );
}

/** The entry of the section nearest the top of the viewport, as the reader scrolls. */
function useSectionInView(ids: readonly string[]): string {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      entries => {
        const shown = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (shown) setActive(shown.target.id);
      },
      { rootMargin: '-96px 0px -60% 0px' }
    );
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

function SectionTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={`${id}-title`} className="font-display text-2xl text-tp-ink">
      {children}
    </h2>
  );
}

/**
 * Language (`pub-language`, `/language`): the Composition2Yaml reference, with an example per section that the gateway's own
 * tests read, each one opening in the composition editor (`/editor`) through a `#composition=` link, which never reaches a
 * server; the specification, the JSON Schema, the versions of the language and what is not in it.
 */
export default function LanguagePage() {
  const active = useSectionInView(INDEX_IDS);

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
    window.history.replaceState(window.history.state, '', `#${id}`);
  };

  return (
    <>
      <Helmet>
        <title>OpenBinding - Composition2Yaml</title>
      </Helmet>
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-8 flex flex-col gap-4">
          <div>
            <p className="text-[11px] tracking-[0.2em] text-tp-steel uppercase">Language</p>
            <h1 className="mt-1 font-display text-3xl text-tp-ink">Composition2Yaml</h1>
            <p className="mt-2 max-w-3xl text-sm text-tp-slate">
              The document of a final composition: the candidate chosen for each task of a workflow,
              where each one came from, and the values the choice yields. The alternatives it was
              chosen from live in a BIM problem, which a composition may link to have its values
              computed and verified.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Action variant="primary" to={editorPath()}>
              <MdEdit aria-hidden="true" /> Write in the editor
            </Action>
            <a className={OUTLINE} href={SPECIFICATION_URL} target="_blank" rel="noreferrer">
              Read the specification <MdNorthEast aria-hidden="true" />
            </a>
            <a
              className={OUTLINE}
              href={SCHEMA_URL}
              target="_blank"
              rel="noreferrer"
              download="composition.schema.json"
            >
              <MdDownload aria-hidden="true" /> Download the schema
            </a>
          </div>
        </div>

        {/* Phone and tablet selector */}
        <div className="sticky top-14 z-10 -mx-4 mb-6 bg-tp-canvas/95 px-4 py-2 backdrop-blur lg:hidden">
          <label className="flex flex-col gap-1 text-xs font-medium text-tp-steel">
            Jump to a section
            <select
              value={active}
              onChange={event => jump(event.target.value)}
              className="h-11 w-full cursor-pointer rounded-md border border-tp-hairline-strong bg-tp-canvas px-3 text-sm text-tp-ink"
            >
              {INDEX.map(entry => (
                <option key={entry.id} value={entry.id}>
                  {entry.nested ? `· ${entry.label}` : entry.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex gap-8">
          {/* Desktop index */}
          <aside className="hidden w-60 shrink-0 lg:block">
            <nav aria-label="Sections" className="sticky top-24 space-y-0.5">
              {INDEX.map(entry => {
                const isActive = active === entry.id;
                return (
                  <a
                    key={entry.id}
                    href={`#${entry.id}`}
                    aria-current={isActive ? 'location' : undefined}
                    className={`flex w-full cursor-pointer items-center rounded-[8px] py-2 text-sm font-medium transition-all duration-150 ${
                      entry.nested ? 'pr-3 pl-6 text-[13px]' : 'px-3'
                    } ${
                      isActive
                        ? 'bg-tp-primary/10 text-tp-accent'
                        : 'text-tp-steel hover:bg-tp-surface hover:text-tp-ink'
                    }`}
                  >
                    {entry.label}
                  </a>
                );
              })}
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col gap-12 pb-8">
            <section
              id={VERSIONS_ID}
              aria-labelledby={`${VERSIONS_ID}-title`}
              className="scroll-mt-36 lg:scroll-mt-24"
            >
              <SectionTitle id={VERSIONS_ID}>Versions of the language</SectionTitle>
              <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-sm text-tp-slate">
                <li>
                  Every document starts with{' '}
                  <code className={CODE}>syntaxVersion: &quot;1.0&quot;</code>, quoted: the version
                  of the language, not of the document. The document’s own label is{' '}
                  <code className={CODE}>version</code>, a semantic version such as{' '}
                  <code className={CODE}>1.3.0</code>.
                </li>
                <li>
                  A minor version (<code className={CODE}>1.x</code>) only adds optional keys, so
                  every <code className={CODE}>1.0</code> document keeps its meaning. A major
                  version changes the meaning of something already there.
                </li>
                <li>A sealed version keeps the syntax version it was sealed with.</li>
                <li>
                  Composition2Yaml is versioned on its own: its syntax version never follows a BIM
                  or toolchain release.
                </li>
              </ul>
            </section>

            <section
              id={EXAMPLES_ID}
              aria-labelledby={`${EXAMPLES_ID}-title`}
              className="scroll-mt-36 lg:scroll-mt-24"
            >
              <SectionTitle id={EXAMPLES_ID}>The language by example</SectionTitle>
              <p className="mt-2 text-sm text-tp-slate">
                Each example is read by the gateway’s tests, so what it says about itself holds.
                Open any of them in the composition editor.
              </p>
              <ol className="mt-6 flex flex-col gap-8">
                {SECTIONS.map(example => {
                  const id = sectionId(example.name);
                  return (
                    <li key={example.name}>
                      <article
                        id={id}
                        aria-labelledby={`${id}-title`}
                        className="flex scroll-mt-36 flex-col gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-5 lg:scroll-mt-24"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 id={`${id}-title`} className="text-lg font-semibold text-tp-ink">
                            {example.name}
                          </h3>
                          {example.expect === 'valid' ? (
                            <Badge variant="success">Valid</Badge>
                          ) : (
                            <Badge variant="error">
                              Refused: <code className="font-mono">{example.expect}</code>
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-tp-slate">{withCode(example.description)}</p>
                        <YamlSourcePanel
                          yamlText={example.yaml}
                          title={`${example.name} · Composition2Yaml`}
                        />
                        <Link
                          className={`${OUTLINE} min-h-8 self-start px-3 text-[13px]`}
                          to={`${editorPath()}${compositionFragment(example.yaml)}`}
                          aria-label={`Open “${example.name}” in the editor`}
                          viewTransition
                        >
                          <MdEdit aria-hidden="true" />
                          Open in editor
                        </Link>
                      </article>
                    </li>
                  );
                })}
              </ol>
            </section>

            <section
              id={OUTSIDE_ID}
              aria-labelledby={`${OUTSIDE_ID}-title`}
              className="scroll-mt-36 lg:scroll-mt-24"
            >
              <SectionTitle id={OUTSIDE_ID}>What is not in the language</SectionTitle>
              <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {NOT_IN_THE_LANGUAGE.map(item => (
                  <div
                    key={item.title}
                    className="rounded-xl border border-tp-hairline bg-tp-canvas p-4"
                  >
                    <dt className="text-sm font-semibold text-tp-ink">{item.title}</dt>
                    <dd className="mt-1 text-sm text-tp-slate">{item.text}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
