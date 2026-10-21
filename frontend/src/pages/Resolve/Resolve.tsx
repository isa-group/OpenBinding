import { useState, type FormEvent } from 'react';
import {
  Calendar, Check, FileText, Loader2, Search, ShieldCheck, User,
} from 'lucide-react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { platformApi, type ResolveLocation, type ResolveResponse } from '../../api/platform';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { CopyField } from '../../components/ui/CopyField';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { buildCitation } from '../../utils/citation';
import { isDigest, normalizeDigest, shortDigest } from '../../utils/digest';
import { formatBytes, formatDate, formatDateTime, yearOf } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import {
  RESOLVE_KINDS, asResolved, extensionOf, formatOf, isKnownKind, kindLabel, locationHref, outcomeOf, summarizeDocument,
  type ResolveOutcome,
} from './resolveModel';
import './Resolve.css';

const PAGE_SIZE = 20;
const HELP_DEFAULT = 'Private and non-existent elements give the same answer, by design.';
const HELP_INVALID = 'Not a valid digest: use sha256- followed by 64 lowercase hex characters.';

export function Resolve() {
  const { kind = 'report', digest = '' } = useParams<{ kind: string; digest: string }>();
  const location = useLocation();
  // The view is rebuilt for every navigation, so the form always starts from what is shown and Verify always asks again.
  return <ResolveView key={location.key} kind={kind} digest={digest} />;
}

function ResolveView({ kind, digest }: { kind: string; digest: string }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const normalized = normalizeDigest(digest);
  const requestKind = kind.trim().toLowerCase();
  const valid = isKnownKind(requestKind) && isDigest(normalized);

  const [kindInput, setKindInput] = useState(isKnownKind(requestKind) ? requestKind : 'report');
  const [digestInput, setDigestInput] = useState(digest);
  const [inputError, setInputError] = useState(false);
  const [offset, setOffset] = useState(0);

  const resource = useResource(
    `${valid ? `${requestKind}/${normalized}` : 'invalid'}@${offset}`,
    () => (valid ? platformApi.resolveElement(requestKind, normalized, PAGE_SIZE, offset) : Promise.resolve(null)),
  );

  const loading = resource.status === 'loading';
  let outcome: ResolveOutcome | null = null;
  if (!valid) outcome = { type: 'invalid' };
  else if (resource.status === 'error') outcome = outcomeOf({ failed: true, error: resource.error });
  else if (resource.status === 'ready') outcome = outcomeOf({ failed: false, data: resource.data });
  // While another page of locations loads, the element stays on screen.
  const stale = asResolved(resource.stale);
  const pageLoading = loading && stale !== null && stale.digest === normalized && stale.kind === requestKind;
  const shown: ResolveResponse | null = outcome?.type === 'resolved' ? outcome.element : pageLoading ? stale : null;

  const invalidInput = inputError || (!valid && digest !== '');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!digestInput.trim()) {
      setInputError(true);
      return;
    }
    const next = normalizeDigest(digestInput);
    // Every submit is a navigation, even to the address already shown: that is what asks again.
    navigate(`/resolve/${kindInput}/${isDigest(next) ? next : encodeURIComponent(digestInput.trim())}`);
  };

  return (
    <div className="resolve-page">
      <h1 className="sr-only">Verify by digest</h1>
      <nav aria-label="Breadcrumb" className="resolve-breadcrumb">
        <Link to="/explore">Explore</Link><span aria-hidden="true">/</span><span>Verify</span>
        <span aria-hidden="true">/</span><span>{requestKind}</span>
        <span aria-hidden="true">/</span><span className="resolve-breadcrumb-digest">{shortDigest(normalized)}</span>
      </nav>

      <form className="resolve-form" onSubmit={submit} noValidate>
        <label>
          <span>Kind</span>
          <select value={kindInput} onChange={(event) => setKindInput(event.target.value)}>
            {RESOLVE_KINDS.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
          </select>
        </label>
        <label className="resolve-form-digest">
          <span>Digest</span>
          <input
            value={digestInput}
            onChange={(event) => { setDigestInput(event.target.value); setInputError(false); }}
            aria-invalid={invalidInput}
            aria-describedby="resolve-digest-help"
            spellCheck={false}
            autoComplete="off"
            placeholder="sha256-…"
          />
        </label>
        <Button type="submit" size="md">Verify</Button>
        <span id="resolve-digest-help" className={invalidInput ? 'is-invalid' : undefined}>{invalidInput ? HELP_INVALID : HELP_DEFAULT}</span>
      </form>

      <div className="resolve-results" aria-live="polite" aria-busy={loading}>
        {loading && !pageLoading && <CheckingState />}
        {!loading && outcome?.type === 'invalid' && <InvalidState digest={digest} kind={kind} />}
        {!loading && outcome?.type === 'malformed' && <MalformedState detail={outcome.detail} />}
        {!loading && outcome?.type === 'not-found' && <NotFoundState />}
        {!loading && outcome?.type === 'unavailable' && <UnavailableState status={outcome.status} onRetry={resource.reload} />}
        {shown && (
          <ResolvedElement
            element={shown}
            signedIn={Boolean(user)}
            loadingLocations={pageLoading}
            offset={offset}
            onPage={setOffset}
          />
        )}
      </div>
    </div>
  );
}

function CheckingState() {
  return (
    <>
      <div className="resolve-checking">
        <Loader2 className="resolve-spinner" aria-hidden="true" />
        <div><strong>Checking…</strong><span>Looking the digest up and comparing the stored content with it.</span></div>
      </div>
      <div className="resolve-skeletons"><Skeleton variant="tile" /><Skeleton variant="tile" /><Skeleton variant="tile" /></div>
    </>
  );
}

function InvalidState({ digest, kind }: { digest: string; kind: string }) {
  const kindProblem = !isKnownKind(kind.trim().toLowerCase());
  return (
    <Notice tone="error" title={kindProblem ? 'That kind isn’t supported' : 'That digest isn’t well formed'}>
      {kindProblem ? (
        <>The resolver supports: {RESOLVE_KINDS.map((item) => item.id).join(', ')}.</>
      ) : (
        <>
          A digest is <code>sha256-</code> followed by 64 lowercase hexadecimal characters, for example{' '}
          <code>sha256-e5f60718e5f60718…e5f60718</code>.{digest ? '' : ' Paste one above to verify it.'}
        </>
      )}
    </Notice>
  );
}

function MalformedState({ detail }: { detail: string }) {
  return (
    <Notice tone="error" title="The resolver refused that request (422)">
      {detail} A digest is <code>sha256-</code> followed by 64 lowercase hexadecimal characters and the kind must be one the resolver supports.
    </Notice>
  );
}

function NotFoundState() {
  return (
    <div className="resolve-empty" role="alert">
      <Search aria-hidden="true" />
      <strong>Nothing found for this digest</strong>
      <span>There is no element you can see with this kind and digest. Check both values, or log in if you expected to have access.</span>
      <small>404 · not_found</small>
    </div>
  );
}

function UnavailableState({ status, onRetry }: { status: number | null; onRetry: () => void }) {
  return (
    <Notice
      tone="error"
      action={<Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>}
    >
      Verification is unavailable right now ({status ? `HTTP ${status}` : 'the gateway can’t be reached'}). This says nothing about the element itself.
    </Notice>
  );
}

interface ResolvedProps {
  element: ResolveResponse;
  signedIn: boolean;
  loadingLocations: boolean;
  offset: number;
  onPage: (offset: number) => void;
}

function ResolvedElement({ element, signedIn, loadingLocations, offset, onPage }: ResolvedProps) {
  const { copy, status } = useCopy();
  const [download, setDownload] = useState<{ phase: 'idle' | 'busy' | 'done' | 'failed'; message: string }>({ phase: 'idle', message: '' });
  const label = kindLabel(element.kind);
  const author = element.author?.username ?? null;
  const created = formatDateTime(element.created_at);
  const size = formatBytes(element.size_bytes);
  const name = element.canonical_name || label;
  const firstLocation = element.locations[0];
  const visibleIn = firstLocation
    ? (firstLocation.organization && firstLocation.project ? `${firstLocation.organization.name} / ${firstLocation.project.name}` : firstLocation.slug ?? label)
    : 'No visible location';
  const uri = `${window.location.origin}/resolve/${element.kind}/${element.digest}`;
  const citation = buildCitation({
    title: name, author, year: yearOf(element.created_at), kindLabel: label.toLowerCase(), digest: element.digest, url: uri,
  });
  const structure = summarizeDocument(element.document);
  const reportHref = element.kind === 'report' ? element.locations.map((item) => locationHref(element.kind, item)).find(Boolean) : null;

  const identity: Array<[string, string]> = [
    ['Name', name],
    ['Format', formatOf(element.media_type)],
    ['Size', size ?? 'Not recorded'],
    ['Created', created ?? 'Not recorded'],
    ['Author', author ?? 'Not listed'],
    ['Visible in', visibleIn],
  ];

  const fetchContent = async () => {
    setDownload({ phase: 'busy', message: '' });
    try {
      const bytes = await platformApi.resolveContent(element.kind, element.digest);
      const url = URL.createObjectURL(new Blob([bytes], { type: element.media_type }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${element.kind}-${element.digest.slice(7, 19)}.${extensionOf(element.media_type)}`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDownload({ phase: 'done', message: `Downloaded ${bytes.byteLength.toLocaleString('en-US')} bytes of ${element.media_type}.` });
    } catch {
      setDownload({ phase: 'failed', message: 'The content could not be downloaded. Try again; the digest itself was verified.' });
    }
  };

  if (!element.verified) {
    return (
      <Notice tone="error" title="Not verified">
        The resolver found this element but could not confirm that its content matches the digest. Do not rely on it.
      </Notice>
    );
  }

  return (
    <>
      <section className="resolve-verdict" aria-label="Verification result">
        <span className="resolve-verdict-mark" aria-hidden="true"><Check /></span>
        <div>
          <span className="resolve-verdict-title"><strong>Verified</strong><span className="resolve-kind-pill">kind · {element.kind}</span></span>
          <p>The content’s SHA-256 matches the digest you asked for.</p>
          <CopyField value={element.digest} label="digest" />
        </div>
      </section>

      <section aria-labelledby="resolve-identity-title" className="resolve-section">
        <h2 id="resolve-identity-title">Identity and provenance</h2>
        <dl className="resolve-identity">
          {identity.map(([term, value]) => (
            <div key={term}><dt>{term}</dt><dd>{value}</dd></div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="resolve-locations-title" className="resolve-section">
        <div className="resolve-section-head">
          <h2 id="resolve-locations-title">Locations</h2>
          <span>{element.pagination.total === 0 ? '0 visible' : `${element.pagination.total} location${element.pagination.total === 1 ? '' : 's'}`}</span>
        </div>
        {element.locations.length === 0 && element.pagination.total === 0 ? (
          <Notice tone="info">
            This element exists and verifies, but none of the places it lives are visible to you, so no locations are listed.
          </Notice>
        ) : (
          <div className="resolve-locations" aria-busy={loadingLocations}>
            <ul>
              {element.locations.map((location) => (
                <LocationRow key={location.element_id} kind={element.kind} location={location} signedIn={signedIn} />
              ))}
            </ul>
            <div className="resolve-locations-foot">
              <span>
                Showing {element.pagination.total === 0 ? 0 : element.pagination.offset + 1}–{element.pagination.offset + element.locations.length} of {element.pagination.total}
              </span>
              <span>
                <button type="button" disabled={offset === 0 || loadingLocations} onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
                <button type="button" disabled={!element.pagination.has_more || loadingLocations} onClick={() => onPage(offset + PAGE_SIZE)}>Next</button>
              </span>
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="resolve-content-title" className="resolve-section">
        <div className="resolve-section-head">
          <h2 id="resolve-content-title">Content</h2>
          <Button size="sm" variant="secondary" onClick={() => void fetchContent()} disabled={download.phase === 'busy'}>
            {download.phase === 'busy' ? 'Downloading…' : 'Download content'}
          </Button>
        </div>
        {download.phase === 'done' && <Notice tone="success">{download.message}</Notice>}
        {download.phase === 'failed' && <Notice tone="error">{download.message}</Notice>}
        <div className="resolve-content">
          <span className="resolve-content-kind">{label}</span>
          <span className="resolve-content-name">{name}</span>
          <div className="resolve-content-chips">
            {author && <Chip tone="accent"><User aria-hidden="true" />{author}</Chip>}
            {created && <Chip tone="accent"><Calendar aria-hidden="true" />{formatDate(element.created_at)}</Chip>}
            <Chip tone="accent"><FileText aria-hidden="true" />{element.media_type}{size ? ` · ${size.split(' (')[0]}` : ''}</Chip>
            <Chip tone="success"><ShieldCheck aria-hidden="true" />Content matches digest</Chip>
          </div>
          {structure.fields.length > 0 ? (
            <div className="resolve-structure">
              <span className="resolve-structure-title">Document structure</span>
              <ul>
                {structure.fields.map((field) => (
                  <li key={field.name}><code>{field.name}</code><span>{field.type}</span><small>{field.detail}</small></li>
                ))}
              </ul>
              {structure.total > structure.fields.length && <small>{structure.total - structure.fields.length} more fields in the download.</small>}
            </div>
          ) : (
            <p className="resolve-structure-note">
              This is not a structured document; download it to inspect the {element.media_type} content.
            </p>
          )}
          {reportHref && signedIn && (
            <p className="resolve-structure-note">The report’s sections and linked evidence render on <Link to={reportHref.href}>the report page</Link> for members of its project.</p>
          )}
        </div>
      </section>

      <section aria-labelledby="resolve-cite-title" className="resolve-section">
        <h2 id="resolve-cite-title">Cite this</h2>
        <div className="resolve-cite">
          <div>
            <span>URI</span>
            <code>{`/resolve/${element.kind}/${element.digest}`}</code>
            <button type="button" onClick={() => void copy(uri, 'uri')}>{status('uri') === 'copied' ? 'URI copied' : 'Copy URI'}</button>
          </div>
          <div>
            <span>Citation</span>
            <p>{citation.text}</p>
            <span className="resolve-cite-actions">
              <button type="button" onClick={() => void copy(citation.text, 'cite')}>{status('cite') === 'copied' ? 'Citation copied' : 'Copy citation'}</button>
              <button type="button" onClick={() => void copy(citation.bibtex, 'bib')}>{status('bib') === 'copied' ? 'Copied for reference manager' : 'Copy for reference manager'}</button>
            </span>
            <small>“Copy for reference manager” puts a BibTeX entry on the clipboard for Zotero, Mendeley or LaTeX.</small>
          </div>
        </div>
      </section>
    </>
  );
}

function initials(text: string): string {
  const words = text.split(/[\s/_-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : text.slice(0, 2)).toUpperCase();
}

function LocationRow({ kind, location, signedIn }: { kind: string; location: ResolveLocation; signedIn: boolean }) {
  const place = location.organization && location.project
    ? `${location.organization.name} / ${location.project.name}`
    : location.slug ?? kindLabel(kind);
  const target = locationHref(kind, location);
  const version = location.version_or_revision !== null && location.version_or_revision !== undefined ? ` · ${location.version_or_revision}` : '';
  const isPublic = location.project?.visibility === 'public';
  return (
    <li>
      <span className="resolve-location-tile" aria-hidden="true">{initials(location.organization?.name ?? place)}</span>
      <div>
        <strong>{place}</strong>
        <code>{location.slug ?? location.element_id}{version}</code>
      </div>
      {location.project && <Chip tone={isPublic ? 'success' : 'plain'}>{isPublic ? 'Public' : 'Private'}</Chip>}
      {target && (target.requiresAccount && !signedIn
        ? <Link to="/login">Log in to open</Link>
        : <Link to={target.href}>{target.requiresAccount ? 'Open in platform' : 'Open'}</Link>)}
    </li>
  );
}
