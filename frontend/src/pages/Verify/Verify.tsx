import { useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useAuth } from '../../contexts/auth';
import { isDigest, normalizeDigest } from '../../utils/digest';
import { formatBytes } from '../../utils/format';
import { ResolveResult } from './ResolveResult';
import { RESOLVE_KINDS, isKnownKind, kindLabel } from './resolveModel';
import { VerifierResult } from './VerifierResult';
import {
  problemOf, verifyDigest, verifyFile, verifyText, type Mode, type Problem, type Result,
} from './verifierChecks';
import { digestPath, lookupPath, parseVerifyInput } from './verifyInput';
import '../Reports/Reports.css';
import './Verify.css';

const MODES: ReadonlyArray<{ id: Mode; label: string }> = [
  { id: 'digest', label: 'Link or digest' },
  { id: 'text', label: 'Document' },
  { id: 'file', label: 'File' },
];

const HELP_DEFAULT = 'Private and non-existent elements give the same answer, by design.';
const HELP_INVALID = 'Not a valid digest: use sha256- followed by 64 lowercase hex characters.';
const HELP_KIND = 'Choose what kind of element the digest names, so it can be looked up.';

type Checking = { status: 'idle' | 'checking' } | { status: 'done'; result: Result } | { status: 'error'; problem: Problem };

function settle(setState: (next: Checking) => void, job: Promise<Result>, isCurrent: () => boolean) {
  job.then(
    (result) => { if (isCurrent()) setState({ status: 'done', result }); },
    (caught: unknown) => { if (isCurrent()) setState({ status: 'error', problem: problemOf(caught) }); },
  );
}

/**
 * The Verify page (`verify`, `/verify/:kind?/:digest?`): opens a permanent link, looks a digest up and, for people with an account,
 * checks a document or a file. The view is rebuilt for every navigation, so the form always starts from what is shown and a new
 * submit always asks again.
 */
export function Verify() {
  const location = useLocation();
  return <VerifyView key={location.key} />;
}

function VerifyView() {
  const { kind = '', digest = '' } = useParams<{ kind: string; digest: string }>();
  const [search] = useSearchParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const signedIn = Boolean(user);
  const queryDigest = search.get('digest') ?? '';
  const addressed = kind !== '' || digest !== '';
  const addressKind = kind.trim().toLowerCase();
  // A digest of no known kind is checked by the verifier, which answers people with an account only.
  const arrival = signedIn && !addressed && queryDigest !== '';

  const [mode, setMode] = useState<Mode>('digest');
  const [digestInput, setDigestInput] = useState(digest || queryDigest);
  const [kindInput, setKindInput] = useState(isKnownKind(addressKind) ? addressKind : '');
  const [emptyInput, setEmptyInput] = useState(false);
  const [needKind, setNeedKind] = useState(false);
  const [text, setText] = useState('');
  const [expected, setExpected] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<Checking>({ status: 'idle' });

  useEffect(() => {
    if (!arrival) return;
    let current = true;
    settle(setState, verifyDigest(queryDigest), () => current);
    return () => { current = false; };
  }, [arrival, queryDigest]);

  // One check at a time: the buttons of the Document and File modes stay disabled while a check runs, the one on arrival included.
  const view: Checking = state.status === 'idle' && arrival ? { status: 'checking' } : state;

  const run = (job: Promise<Result>) => {
    setState({ status: 'checking' });
    settle(setState, job, () => true);
  };

  const parsedInput = parseVerifyInput(digestInput);
  const typedDigest = parsedInput.digest;
  // The selector appears when neither the address nor the pasted link names a kind.
  const showKind = !signedIn && !isKnownKind(addressKind) && parsedInput.kind === null;
  const invalidDigest = emptyInput || (addressed && digest !== '' && !isDigest(normalizeDigest(digest)));
  const askForKind = !signedIn && !addressKind && (needKind || queryDigest !== '');

  const submitDigest = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseVerifyInput(digestInput);
    if (!parsed.digest) {
      setEmptyInput(true);
      return;
    }
    // Every submit is a navigation, even to the address already shown: that is what asks again.
    const chosen = parsed.kind ?? (signedIn ? null : kindInput || null);
    if (chosen) navigate(lookupPath(chosen, parsed.digest));
    else if (signedIn) navigate(digestPath(parsed.digest));
    else setNeedKind(true);
  };

  const chooseKind = (chosen: string) => {
    setKindInput(chosen);
    setNeedKind(false);
    if (chosen && isDigest(normalizeDigest(typedDigest))) navigate(lookupPath(chosen, typedDigest));
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  };

  const checking = view.status === 'checking';
  const help = invalidDigest ? HELP_INVALID : askForKind ? HELP_KIND : HELP_DEFAULT;

  return (
    <div className="verify-page">
      <nav aria-label="Breadcrumb" className="resolve-breadcrumb">
        <Link to="/explore">Explore</Link><span aria-hidden="true">/</span><span>Verify</span>
        {addressKind && <><span aria-hidden="true">/</span><span>{addressKind}</span></>}
        {digest && <><span aria-hidden="true">/</span><span className="resolve-breadcrumb-digest">{isKnownKind(addressKind) ? kindLabel(addressKind) : 'Element'}</span></>}
      </nav>

      <header className="verify-title">
        <h1>Verify</h1>
        <p>Check that a permanent link, a digest, a document or a file is exactly what OpenBinding recorded.</p>
      </header>

      <section className="rp-card vf-form" aria-label="What to check">
        <TabBar ariaLabel="What to check" prefix="vf" value={mode} onChange={(id) => setMode(id as Mode)} items={MODES.map((item) => ({ id: item.id, label: item.label }))} />
        <TabPanel prefix="vf" active={mode}>
          {mode === 'digest' && (
            <form className="vf-lookup" onSubmit={submitDigest} noValidate>
              {showKind && (
                <label className="rp-field">
                  <span>Kind</span>
                  <select value={kindInput} aria-invalid={needKind} onChange={(event) => chooseKind(event.target.value)}>
                    <option value="">Choose a kind</option>
                    {RESOLVE_KINDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>
              )}
              <label className="rp-field vf-lookup-digest">
                <span>Link or digest</span>
                <input
                  className="is-mono"
                  value={digestInput}
                  onChange={(event) => { setDigestInput(event.target.value); setEmptyInput(false); }}
                  aria-invalid={invalidDigest}
                  aria-describedby="verify-help"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="sha256-… or a permanent link"
                />
              </label>
              <Action type="submit" variant="primary">Verify</Action>
              <span id="verify-help" className={invalidDigest ? 'is-invalid' : undefined}>{help}</span>
            </form>
          )}
          {mode !== 'digest' && !signedIn && (
            <div className="vf-login">
              <p>Log in to check a document or a file</p>
              <Action to="/login" variant="primary" size="sm">Log in</Action>
            </div>
          )}
          {mode === 'text' && signedIn && (
            <form className="vf-lookup vf-stack" onSubmit={(event) => { event.preventDefault(); run(verifyText(text, expected)); }}>
              <label className="rp-field">
                <span>Paste the document’s text</span>
                <textarea value={text} rows={6} spellCheck={false} placeholder="The exact JSON of a published result, a problem version or a package description" onChange={(event) => setText(event.target.value)} />
              </label>
              <label className="rp-field">
                <span>Fingerprint it should have (optional)</span>
                <input className="is-mono" value={expected} spellCheck={false} autoComplete="off" placeholder="sha256-…" onChange={(event) => setExpected(event.target.value)} />
              </label>
              <small className="rp-muted">Spacing and key order don’t matter: the text is normalised before fingerprinting. Add the fingerprint you expect to see “Doesn’t match” if it differs.</small>
              <Action type="submit" variant="primary" disabled={text.trim() === '' || checking} busy={checking} className="vf-check">Verify</Action>
            </form>
          )}
          {mode === 'file' && signedIn && (
            <form className="vf-lookup vf-stack" onSubmit={(event) => { event.preventDefault(); if (file) run(verifyFile(file)); }}>
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
              <Action type="submit" variant="primary" disabled={file === null || checking} busy={checking} className="vf-check">Verify</Action>
            </form>
          )}
        </TabPanel>
      </section>

      {view.status === 'idle' && !addressed && !askForKind && <p className="rp-muted">Enter a link or a digest to check.</p>}
      {view.status === 'checking' && <p className="vf-checking" role="status">Computing in your browser and asking the server…</p>}
      {view.status === 'error' && (
        view.problem.session ? (
          <Notice tone="warning" title={view.problem.title} action={<Action to="/login" variant="primary" size="sm">Log in</Action>}>{view.problem.text}</Notice>
        ) : (
          <Notice tone="error" title={view.problem.title}>{view.problem.text}</Notice>
        )
      )}
      {view.status === 'done' && <VerifierResult result={view.result} />}
      {view.status === 'idle' && addressed && <ResolveResult kind={kind} digest={digest} signedIn={signedIn} />}
    </div>
  );
}
