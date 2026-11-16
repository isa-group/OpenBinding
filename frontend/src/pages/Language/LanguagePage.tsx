import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Download, Link2, Play, RotateCcw } from 'lucide-react';
import { CodeEditor } from '../../components/CodeEditor/CodeEditor';
import { SourceView } from '../../components/rendering/SourceView';
import { Action } from '../../components/ui/Action';
import { Badge } from '../../components/ui/Badge';
import { Notice } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useCopy } from '../../components/ui/useCopy';
import { config } from '../../config';
import examples from '../../content/composition2yaml-examples.json';
import { languageApi } from '../../entities/composition/api';
import { readApiError } from '../../shared/api/errors';
import type { ValidateResult } from '../../shared/api/types';
import { fromC2y, type Located } from '../../shared/diagnostics/located';
import { createScheduler, pausedMessage, type Scheduler, type SchedulerStatus } from '../../shared/editor/lintScheduler';
import {
  compositionFragment, readCompositionFragment, takeCompositionFragment, type CompositionFragment,
} from '../../shared/sphere/composition-fragment';
import { ProblemsPanel } from '../../widgets/problems-panel/ProblemsPanel';
import './LanguagePage.css';

/** Milliseconds of stillness before the playground lints its text: the anonymous read budget is 60 a minute (A-7). */
export const LANGUAGE_LINT_DELAY_MS = 800;

/** The file the playground's findings are located in. */
const FILE = 'composition.yaml';

/** The normative specification, on GitHub. */
export const SPECIFICATION_URL = 'https://github.com/isa-group/OpenBinding/blob/main/docs/COMPOSITION2YAML.md';
/** The JSON Schema of the latest syntax version, as the gateway serves it. */
export const SCHEMA_URL = `${config.apiBaseUrl}/v1/compositions/schema`;

/** One example of the reference: `expect` is `valid` (no finding at all) or the code that refuses it (the gateway's test holds both). */
export interface LanguageExample {
  name: string;
  description: string;
  yaml: string;
  expect: string;
}

export const STARTER: string = examples.starter;
export const SECTIONS: readonly LanguageExample[] = examples.sections;

const NOT_IN_THE_LANGUAGE: readonly { title: string; text: string }[] = [
  { title: 'The alternatives', text: 'Candidates to choose from, constraints, objectives, demand and its variants are the BIM problem’s. A different demand is a different problem revision.' },
  { title: 'Optimisation settings', text: 'Weights and scalarisation belong to a run preset, never to a document.' },
  { title: 'The offering’s content', text: 'Plans, prices and limits stay in SPHERE or in the Pricing2Yaml file. The document holds one reference, without a version.' },
  { title: 'Presentation', text: 'Sections, highlights, labels and layout are decided by the screen that renders a composition, never written in the document.' },
  { title: 'Identity and visibility', text: 'Who owns a composition, who may read it and whether it is public belong to the platform, not to the document.' },
];

/** `backticks` in the content are code. */
function withCode(text: string): ReactNode[] {
  return text.split('`').map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part));
}

/** The text the playground opens with: the composition a share link carries, or the starter (with why the link could not be read). */
function opening(fragment: CompositionFragment): { text: string; issue: string | null } {
  if (fragment.status === 'ok') return { text: fragment.yaml, issue: null };
  return { text: STARTER, issue: fragment.status === 'invalid' ? fragment.error : null };
}

type Canonical = { text: string; canonical: string | null; message: string | null };

interface LanguagePageProps {
  /** The lint delay, in milliseconds (tests shorten it). */
  delay?: number;
}

/**
 * Language (`pub-language`, `/language`): the Composition2Yaml reference, with an example per section that the gateway's own tests
 * read, and a playground on the stateless language routes. The playground lints as the text changes (`validate`, 800 ms), lists the
 * findings beside the code, shows the canonical form (`parse`, then `serialise`) and copies a share link that carries the text in
 * its `#composition=` fragment, which never reaches a server. Opening such a link loads its text.
 */
export function LanguagePage({ delay = LANGUAGE_LINT_DELAY_MS }: LanguagePageProps) {
  const [start] = useState(() => opening(readCompositionFragment(window.location.hash)));
  const [text, setText] = useState(start.text);
  const [linkIssue, setLinkIssue] = useState<string | null>(start.issue);
  const [selection, setSelection] = useState<{ anchor: number; head: number } | undefined>();
  const [panel, setPanel] = useState<'problems' | 'canonical'>('problems');
  const playground = useRef<HTMLElement>(null);
  const { copy, status: copied } = useCopy();

  // The fragment has been read: it leaves the address bar. A link opened while the page is open (only the fragment changes) loads too.
  useEffect(() => {
    takeCompositionFragment(window.location, window.history);
    const onHashChange = () => {
      const fragment = takeCompositionFragment(window.location, window.history);
      if (fragment.status === 'ok') {
        setText(fragment.yaml);
        setLinkIssue(null);
      } else if (fragment.status === 'invalid') {
        setLinkIssue(fragment.error);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // -- The lint

  const [validated, setValidated] = useState<{ text: string; result: ValidateResult } | null>(null);
  const [lintIssue, setLintIssue] = useState<string | null>(null);
  const [status, setStatus] = useState<SchedulerStatus>({ state: 'idle' });
  const linter = useRef<Scheduler<string> | null>(null);
  useEffect(() => {
    const lints = createScheduler<string, ValidateResult>({
      delay,
      run: (input, signal) => languageApi.validate(input, signal),
      onResult: (result, input) => {
        setValidated({ text: input, result });
        setLintIssue(null);
      },
      onError: (reason) => setLintIssue(readApiError(reason).message || 'The text couldn’t be checked.'),
      onStatus: setStatus,
    });
    linter.current = lints;
    return () => lints.dispose();
  }, [delay]);

  useEffect(() => {
    linter.current?.schedule(text);
  }, [text]);

  // While the checks are paused the notice counts down.
  const pausedUntil = status.state === 'paused' ? status.until : null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (pausedUntil === null) return undefined;
    const timer = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [pausedUntil]);

  const diagnostics: Located[] = useMemo(
    () => (validated ? validated.result.diagnostics.map((item) => fromC2y(item, validated.text, FILE)) : []),
    [validated],
  );
  const current = validated && validated.text === text ? validated.result : null;

  // -- The canonical form, read only while it is on screen

  const [canonical, setCanonical] = useState<Canonical | null>(null);
  const canonicaliser = useRef<Scheduler<string> | null>(null);
  useEffect(() => {
    const canonicals = createScheduler<string, string>({
      delay,
      run: async (input, signal) => languageApi.serialise((await languageApi.parse(input, signal)).document, signal),
      onResult: (written, input) => setCanonical({ text: input, canonical: written, message: null }),
      onError: (reason, input) => {
        const refusal = readApiError(reason);
        setCanonical({
          text: input,
          canonical: null,
          message: refusal.status === 422 ? 'The text has errors: fix them to see its canonical form.' : refusal.message || 'The canonical form couldn’t be read.',
        });
      },
    });
    canonicaliser.current = canonicals;
    return () => canonicals.dispose();
  }, [delay]);

  useEffect(() => {
    if (panel === 'canonical') canonicaliser.current?.schedule(text);
    else canonicaliser.current?.cancel();
  }, [text, panel]);

  const canonicalNow = canonical && canonical.text === text ? canonical : null;

  // -- Actions

  const select = (diagnostic: Located) => {
    if (diagnostic.where.kind === 'text') setSelection({ anchor: diagnostic.where.from, head: diagnostic.where.to });
  };

  const load = (yaml: string) => {
    setText(yaml);
    setLinkIssue(null);
    playground.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const shareLink = () => {
    const { origin, pathname, search } = window.location;
    return `${origin}${pathname}${search}${compositionFragment(text)}`;
  };

  let statusText = '';
  if (copied('share') === 'copied') statusText = 'Share link copied. It carries the text in its fragment; nothing is sent to the gateway.';
  else if (copied('share') === 'failed') statusText = 'The share link couldn’t be copied.';
  else if (pausedUntil !== null) statusText = pausedMessage(pausedUntil);
  else if (lintIssue && !current) statusText = '';
  else if (status.state === 'waiting' || status.state === 'running' || !current) statusText = 'Checking…';
  else statusText = current.valid ? 'Valid Composition2Yaml' : 'Not valid yet';

  return (
    <div className="lang-page">
      <PageHeader
        eyebrow="Language"
        title="Composition2Yaml"
        lede="The document of a final composition: the candidate chosen for each task of a workflow, where each one came from, and the values the choice yields. The alternatives it was chosen from live in a BIM problem, which a composition may link to have its values computed and verified."
        actions={(
          <>
            <a className="ui-action is-secondary is-md" href={SPECIFICATION_URL} target="_blank" rel="noreferrer">
              Read the specification <ArrowUpRight aria-hidden="true" />
            </a>
            <a className="ui-action is-secondary is-md" href={SCHEMA_URL} target="_blank" rel="noreferrer" download="composition.schema.json">
              <Download aria-hidden="true" /> Download the schema
            </a>
          </>
        )}
      />

      <section ref={playground} className="lang-section lang-playground" aria-labelledby="lang-playground-title">
        <div className="lang-section-head">
          <h2 id="lang-playground-title">Playground</h2>
          <p>
            Write a composition and the gateway checks it as you type. Nothing is stored: the checks are the stateless language
            services, and a share link keeps the text in the address, after the <code>#</code>.
          </p>
        </div>

        <div className="lang-toolbar" role="toolbar" aria-label="Playground">
          <Action size="sm" variant="ghost" onClick={() => void copy(shareLink(), 'share')}><Link2 aria-hidden="true" />Copy share link</Action>
          <Action size="sm" variant="ghost" onClick={() => load(STARTER)} disabled={text === STARTER}><RotateCcw aria-hidden="true" />Start over</Action>
          <span className="lang-status" role="status" aria-live="polite">{statusText}</span>
        </div>

        {linkIssue && (
          <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={() => setLinkIssue(null)}>Dismiss</Action>}>{linkIssue}</Notice>
        )}
        {lintIssue && <Notice tone="warning">{`The gateway couldn’t check the text: ${lintIssue}`}</Notice>}

        <div className="lang-workspace">
          <CodeEditor
            value={text}
            onChange={setText}
            language="yaml"
            ariaLabel="composition.yaml source"
            minHeight="320px"
            maxHeight="70vh"
            diagnostics={diagnostics}
            selection={selection}
          />
          <div className="lang-side">
            <TabBar
              items={[{ id: 'problems', label: 'Problems' }, { id: 'canonical', label: 'Canonical form' }]}
              value={panel}
              onChange={(id) => setPanel(id === 'canonical' ? 'canonical' : 'problems')}
              ariaLabel="Playground results"
              prefix="lang-results"
            />
            <TabPanel prefix="lang-results" active={panel}>
              {panel === 'problems' && <ProblemsPanel diagnostics={diagnostics} onSelect={select} />}
              {panel === 'canonical' && (
                <div className="lang-canonical">
                  <p className="lang-muted">The exact text a seal would store: keys in order, block style, quotes only where YAML needs them.</p>
                  {!canonicalNow && <p className="lang-muted" role="status">Reading the canonical form…</p>}
                  {canonicalNow?.message && <Notice tone="info">{canonicalNow.message}</Notice>}
                  {typeof canonicalNow?.canonical === 'string' && (
                    <>
                      <SourceView source={canonicalNow.canonical} label="Canonical form" language="yaml" filename="composition.yaml" maxHeight="60vh" />
                      <Action size="sm" variant="secondary" onClick={() => setText(canonicalNow.canonical ?? text)} disabled={canonicalNow.canonical === text}>
                        Use the canonical form
                      </Action>
                    </>
                  )}
                </div>
              )}
            </TabPanel>
          </div>
        </div>
      </section>

      <section className="lang-section" aria-labelledby="lang-versions-title">
        <div className="lang-section-head">
          <h2 id="lang-versions-title">Versions of the language</h2>
        </div>
        <ul className="lang-points">
          <li>Every document starts with <code>syntaxVersion: &quot;1.0&quot;</code>, quoted: the version of the language, not of the document. The document’s own label is <code>version</code>, a semantic version such as <code>1.3.0</code>.</li>
          <li>A minor version (<code>1.x</code>) only adds optional keys, so every <code>1.0</code> document keeps its meaning. A major version changes the meaning of something already there.</li>
          <li>A sealed version keeps the syntax version it was sealed with.</li>
          <li>Composition2Yaml is versioned on its own: its syntax version never follows a BIM or toolchain release.</li>
        </ul>
      </section>

      <section className="lang-section" aria-labelledby="lang-examples-title">
        <div className="lang-section-head">
          <h2 id="lang-examples-title">The language by example</h2>
          <p>Each example is read by the gateway’s tests, so what it says about itself holds. Open any of them in the playground.</p>
        </div>
        <ol className="lang-examples">
          {SECTIONS.map((example) => (
            <li key={example.name}>
              <article className="lang-example" aria-labelledby={`lang-example-${slugOf(example.name)}`}>
                <div className="lang-example-head">
                  <h3 id={`lang-example-${slugOf(example.name)}`}>{example.name}</h3>
                  {example.expect === 'valid'
                    ? <Badge variant="success">Valid</Badge>
                    : <Badge variant="error">Refused: <code>{example.expect}</code></Badge>}
                </div>
                <p>{withCode(example.description)}</p>
                <SourceView source={example.yaml} label={`${example.name} source`} language="yaml" />
                <Action size="sm" variant="secondary" onClick={() => load(example.yaml)} aria-label={`Open “${example.name}” in the playground`}>
                  <Play aria-hidden="true" />Open in the playground
                </Action>
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
          {NOT_IN_THE_LANGUAGE.map((item) => (
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

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
