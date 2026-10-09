import { useEffect, useState, type DragEvent } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { Check, CircleHelp, Info, TriangleAlert } from 'lucide-react';
import { HttpError } from '../../api/client';
import { platformApi, type VerifierEntity, type VerifierStatus, type VerifierVerdict } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useCopy } from '../../components/ui/useCopy';
import { buildCitation } from '../../utils/citation';
import { computeCanonicalDigest, computeFileSha256 } from '../../utils/canonicalDigest';
import { isDigest, normalizeDigest } from '../../utils/digest';
import { formatBytes, yearOf } from '../../utils/format';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { Breadcrumb } from '../Organization/parts';
import { entityHref, entityKind } from '../Platform/verifierOptions';
import '../Project/Project.css';
import './Reports.css';

type Mode = 'digest' | 'text' | 'file';

const MODES: ReadonlyArray<{ id: Mode; label: string }> = [
  { id: 'digest', label: 'Fingerprint' },
  { id: 'text', label: 'Document text' },
  { id: 'file', label: 'File' },
];

const BAD_FINGERPRINT = 'That isn’t a valid fingerprint. A fingerprint is sha256- followed by 64 lowercase hexadecimal characters.';

/** Input the page itself refuses before asking the server. */
class InputError extends Error {}

interface Result {
  mode: Mode;
  verdict: VerifierVerdict;
  /** The fingerprint the browser computed (document or file), when there was something to compute. */
  client: string | null;
  /** The fingerprint the person typed. */
  given: string | null;
}

async function verifyDigest(raw: string): Promise<Result> {
  const given = normalizeDigest(raw);
  if (!isDigest(given)) throw new InputError(BAD_FINGERPRINT);
  return { mode: 'digest', verdict: await platformApi.verifierCheck({ digest: given }), client: null, given };
}

async function verifyText(text: string, expected: string): Promise<Result> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InputError('That text isn’t a JSON document. The verifier fingerprints documents after normalising them, so spacing and key order don’t matter, but the content must be JSON.');
  }
  const given = expected.trim() ? normalizeDigest(expected) : null;
  if (given && !isDigest(given)) throw new InputError(BAD_FINGERPRINT);
  const client = await computeCanonicalDigest(parsed);
  return { mode: 'text', verdict: await platformApi.verifierCheck({ document: parsed, digest: given }), client, given };
}

async function verifyFile(file: File): Promise<Result> {
  const client = await computeFileSha256(file);
  return { mode: 'file', verdict: await platformApi.verifierCheckFile(file, file.name), client, given: null };
}

const VERDICTS: Record<VerifierStatus, { title: string; text: string; tone: 'ok' | 'info' | 'bad' | 'plain'; Icon: typeof Check }> = {
  verified: { title: 'Verified', text: 'The fingerprint is what OpenBinding recorded.', tone: 'ok', Icon: Check },
  computed: { title: 'Computed, not on record', text: 'We computed its fingerprint, but OpenBinding hasn’t recorded anything with it. That’s normal for drafts or local files.', tone: 'info', Icon: Info },
  mismatch: { title: 'Doesn’t match', text: 'The content you gave hashes differently from the fingerprint you expected. It was changed somewhere along the way.', tone: 'bad', Icon: TriangleAlert },
  not_found: { title: 'Nothing found', text: 'OpenBinding has no element recorded with this fingerprint, or you can’t see it.', tone: 'plain', Icon: CircleHelp },
};

function problemOf(caught: unknown): { title: string; text: string; session: boolean } {
  if (caught instanceof InputError) return { title: 'That can’t be checked', text: caught.message, session: false };
  const failure = classifyAuthError(caught);
  const at = marker(failure);
  if (failure.status === 401) return { title: `Your session ended${at}`, text: 'Log in again to keep checking.', session: true };
  if (failure.status === 413) return { title: `That file is too large to check here${at}`, text: 'Compute its SHA-256 yourself and paste the fingerprint instead.', session: false };
  if (failure.status === 422) return { title: `That isn’t a valid fingerprint or document${at}`, text: `${failure.message ? `${failure.message}. ` : ''}A fingerprint is sha256- followed by 64 lowercase hexadecimal characters.`, session: false };
  if (failure.status === 403) return { title: `This API key can’t use the verifier${at}`, text: 'Use a browser session, or a key with instances:read.', session: false };
  if (failure.kind === 'unavailable' || failure.kind === 'network') return { title: 'The verifier didn’t answer', text: `A service OpenBinding depends on isn’t answering${at}. This says nothing about the content. Try again in a moment.`, session: false };
  return { title: `The check failed${at}`, text: caught instanceof HttpError ? caught.message : 'Try again.', session: false };
}

function Fingerprints({ result }: { result: Result }) {
  const { verdict, client, given, mode } = result;
  const recorded = (verdict.entities?.length ?? 0) > 0;
  const left = mode === 'digest' ? { label: 'Fingerprint you gave', value: given ?? verdict.digest } : { label: 'Computed in your browser', value: client ?? verdict.digest };
  const right = verdict.status === 'mismatch'
    ? { label: 'Fingerprint you expected', value: verdict.digest }
    : { label: 'Recorded by OpenBinding', value: recorded ? verdict.digest : 'nothing recorded' };
  return (
    <div className="vf-fps">
      <div><span>{left.label}</span><code>{left.value}</code></div>
      <div><span>{right.label}</span><code>{right.value}</code></div>
    </div>
  );
}

function Matches({ entities, hidden, digest }: { entities: VerifierEntity[]; hidden: number; digest: string }) {
  return (
    <section className="rp-card" aria-labelledby="vf-matches-title">
      <h2 id="vf-matches-title">Matches</h2>
      {entities.length === 0 && <p className="rp-muted">{hidden > 0 ? `${hidden} match${hidden === 1 ? '' : 'es'} outside the chosen project ${hidden === 1 ? 'is' : 'are'} hidden.` : 'No element is recorded with this fingerprint.'}</p>}
      <ul className="vf-matches">
        {entities.map((entity) => {
          const kind = entityKind(entity.entity_type);
          const href = entityHref(entity);
          const place = entity.organization_slug && entity.project_slug ? `${entity.organization_slug} / ${entity.project_slug}` : null;
          return (
            <li key={`${entity.entity_type}:${entity.id}`}>
              <Chip tone="accent">{kind.label}</Chip>
              <strong>{entity.title_or_name ?? entity.slug ?? entity.id}</strong>
              {place && <small>{place}</small>}
              <span className="rp-links">
                {href && <Link to={href}>Open</Link>}
                {kind.resolve && <Link to={`/resolve/${kind.resolve}/${digest}`}>Public record</Link>}
              </span>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && entities.length > 0 && <small className="rp-muted">{hidden} more outside the chosen project.</small>}
    </section>
  );
}

function CitationCard({ verdict, entity }: { verdict: VerifierVerdict; entity: VerifierEntity }) {
  const { copy, status } = useCopy();
  const kind = entityKind(entity.entity_type);
  const origin = window.location.origin;
  const url = kind.resolve ? `${origin}/resolve/${kind.resolve}/${verdict.digest}` : `${origin}/app/verifier?digest=${encodeURIComponent(verdict.digest)}`;
  const citation = buildCitation({
    title: entity.title_or_name ?? kind.label, author: null, year: yearOf(entity.created_at), kindLabel: kind.label.toLowerCase(), digest: verdict.digest, url,
  });
  return (
    <section className="rp-card is-seal" aria-labelledby="vf-cite-title">
      <h2 id="vf-cite-title" className="rp-eyebrow">Cite as</h2>
      <span className="rp-cite">{citation.text}</span>
      <span className="rp-links">
        <button type="button" onClick={() => void copy(citation.text, 'cite')}>{status('cite') === 'copied' ? 'Citation copied' : 'Copy citation'}</button>
        <button type="button" onClick={() => void copy(citation.bibtex, 'bib')}>{status('bib') === 'copied' ? 'Copied for reference manager' : 'Copy for reference manager'}</button>
      </span>
    </section>
  );
}

function VerdictView({ result, scope }: { result: Result; scope: { org: string; project: string; name: string } | null }) {
  const { verdict } = result;
  const verdictWords = VERDICTS[verdict.status];
  const all = verdict.entities ?? [];
  const shown = scope ? all.filter((entity) => entity.organization_slug === scope.org && entity.project_slug === scope.project) : all;
  const text = result.mode === 'digest' && verdict.status === 'verified' ? 'OpenBinding recorded an element with this fingerprint.' : verdictWords.text;
  const disagree = result.client !== null && result.mode !== 'digest' && verdict.status !== 'mismatch' && result.client !== verdict.digest;
  return (
    <>
      <section className={`vf-verdict is-${verdictWords.tone}`} aria-live="polite" aria-label="Verdict">
        <span className="vf-glyph" aria-hidden="true"><verdictWords.Icon size={26} /></span>
        <div>
          <strong>{verdictWords.title}</strong>
          <span>{text}</span>
          {verdict.detail && <small>{verdict.detail}</small>}
        </div>
      </section>
      {disagree && (
        <Notice tone="warning" title="Your browser and the server disagree">
          The browser computed {result.client} but the server computed {verdict.digest} for the same input. Don’t rely on either until that is explained.
        </Notice>
      )}
      <Fingerprints result={result} />
      {(verdict.status === 'verified' || all.length > 0) && <Matches entities={shown} hidden={all.length - shown.length} digest={verdict.digest} />}
      {verdict.status === 'verified' && shown[0] && <CitationCard verdict={verdict} entity={shown[0]} />}
      {verdict.canonical_json && (
        <details className="rp-source">
          <summary>View source</summary>
          <pre aria-label="Normalised document">{verdict.canonical_json}</pre>
        </details>
      )}
    </>
  );
}

/**
 * The verifier (`verifier`, `/app/verifier`): is a fingerprint, a document or a file exactly what OpenBinding recorded? The browser computes the
 * fingerprint of what it is given and the server says what it has recorded. `?digest=` starts a check on arrival. Visitors never reach it: the
 * router sends them to log in, and a session that ends while the page is open is said so.
 */
export function Verifier() {
  const [params] = useSearchParams();
  const context = useOutletContext<PlatformOutletContext | null>();
  const initial = params.get('digest') ?? '';
  const [mode, setMode] = useState<Mode>('digest');
  const [digest, setDigest] = useState(initial);
  const [text, setText] = useState('');
  const [expected, setExpected] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [onlyHere, setOnlyHere] = useState(false);
  const [state, setState] = useState<{ status: 'idle' | 'checking' | 'done' | 'error'; result?: Result; problem?: ReturnType<typeof problemOf> }>({ status: initial ? 'checking' : 'idle' });

  const run = (job: Promise<Result>) => {
    setState({ status: 'checking' });
    job.then(
      (result) => setState({ status: 'done', result }),
      (caught: unknown) => setState({ status: 'error', problem: problemOf(caught) }),
    );
  };

  useEffect(() => {
    if (!initial) return;
    let live = true;
    verifyDigest(initial).then(
      (result) => { if (live) setState({ status: 'done', result }); },
      (caught: unknown) => { if (live) setState({ status: 'error', problem: problemOf(caught) }); },
    );
    return () => { live = false; };
  }, [initial]);

  const ready = mode === 'digest' ? digest.trim() !== '' : mode === 'text' ? text.trim() !== '' : file !== null;
  const check = () => {
    if (mode === 'digest') run(verifyDigest(digest));
    else if (mode === 'text') run(verifyText(text, expected));
    else if (file) run(verifyFile(file));
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  };

  const scope = context?.organization && context.project ? { org: context.organization.slug, project: context.project.slug, name: context.project.name } : null;

  return (
    <div className="proj-frame">
      <div className="proj-band">
        <div className="proj-band-inner"><Breadcrumb items={[{ label: 'Home', to: '/app' }, { label: 'Verifier' }]} /></div>
      </div>
      <div className="proj-body rp-body is-wide">
        <header className="proj-title-row">
          <div className="proj-title">
            <h1>Verifier</h1>
            <p>Check that a fingerprint, a document or a file is exactly what OpenBinding recorded. Your browser computes the fingerprint and the server confirms it.</p>
          </div>
        </header>

        <section className="rp-card vf-form" aria-label="What to check">
          <TabBar ariaLabel="What to check" prefix="vf" value={mode} onChange={(id) => setMode(id as Mode)} items={MODES.map((item) => ({ id: item.id, label: item.label }))} />
          <TabPanel prefix="vf" active={mode}>
            {mode === 'digest' && (
              <label className="rp-field">
                <span>Fingerprint</span>
                <input className="is-mono" value={digest} spellCheck={false} autoComplete="off" placeholder="sha256-…" onChange={(event) => setDigest(event.target.value)} />
              </label>
            )}
            {mode === 'text' && (
              <>
                <label className="rp-field">
                  <span>Paste the document’s text</span>
                  <textarea value={text} rows={6} spellCheck={false} placeholder="The exact JSON of a report, a version or a package description" onChange={(event) => setText(event.target.value)} />
                </label>
                <label className="rp-field">
                  <span>Fingerprint it should have (optional)</span>
                  <input className="is-mono" value={expected} spellCheck={false} autoComplete="off" placeholder="sha256-…" onChange={(event) => setExpected(event.target.value)} />
                </label>
                <small className="rp-muted">Spacing and key order don’t matter: the text is normalised before fingerprinting. Add the fingerprint you expect to see “Doesn’t match” if it differs.</small>
              </>
            )}
            {mode === 'file' && (
              <div
                className={`vf-drop${dragging ? ' is-dragging' : ''}`}
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={drop}
              >
                <strong>Drop a file to check</strong>
                <label className="ui-action is-secondary is-md vf-choose">
                  Choose file
                  <input type="file" className="sr-only" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
                </label>
                <small>{file ? `${file.name} · ${formatBytes(file.size)?.split(' (')[0]}` : 'The file’s SHA-256 is computed in your browser; the file itself is sent so the server can confirm it.'}</small>
              </div>
            )}
          </TabPanel>
          {scope && (
            <label className="rp-check">
              <input type="checkbox" checked={onlyHere} onChange={(event) => setOnlyHere(event.target.checked)} />
              Only show matches inside {scope.name}
            </label>
          )}
          <Action variant="primary" onClick={check} disabled={!ready || state.status === 'checking'} busy={state.status === 'checking'} className="vf-check">Check</Action>
        </section>

        {state.status === 'checking' && <p className="vf-checking" role="status">Computing in your browser and asking the server…</p>}
        {state.status === 'idle' && <p className="rp-muted">Enter something to check.</p>}
        {state.status === 'error' && state.problem && (
          state.problem.session ? (
            <Notice tone="warning" title={state.problem.title} action={<Action to="/login" variant="primary" size="sm">Log in</Action>}>{state.problem.text}</Notice>
          ) : (
            <Notice tone="error" title={state.problem.title}>{state.problem.text}</Notice>
          )
        )}
        {state.status === 'done' && state.result && <VerdictView result={state.result} scope={onlyHere ? scope : null} />}
      </div>
    </div>
  );
}
