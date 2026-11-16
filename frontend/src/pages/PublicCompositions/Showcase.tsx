// Design follows SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a); no code copied
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { platformApi, type Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { compositionsApi } from '../../entities/composition/api';
import { pickVersion } from '../../entities/composition/versionRef';
import { compositionViewModel } from '../../entities/composition/viewModel';
import { ForkCompositionDialog } from '../../features/fork/ForkCompositionDialog';
import { Gate } from '../../features/workspace/parts';
import { compositionPath, publicCompositionsPath, showcasePath } from '../../routes/paths/compositions';
import { classifyAuthError, marker } from '../../shared/api/errors';
import type { CompositionVersionView, CompositionView } from '../../shared/api/types';
import { useResource } from '../../utils/useResource';
import { CompositionRenderer } from '../../widgets/composition-renderer/CompositionRenderer';
import './PublicCompositions.css';

interface Loaded {
  composition: CompositionView;
  /** Light rows, newest first. */
  versions: CompositionVersionView[];
}

/**
 * The one answer for a composition that is not there and for one the reader may not see: the gateway answers both with the same 404,
 * so the page does too, and never says that a composition is private (D10).
 */
function ShowcaseMissing() {
  return (
    <Gate title="No composition here, or you cannot see it" action={<Action to={publicCompositionsPath()} variant="primary">Public compositions</Action>}>
      The address may be mistyped, the composition may have been deleted, or it is not shared with you. We answer the same way in every one of these.
    </Gate>
  );
}

function ShowcaseBody({ org, slug, loaded, membership }: { org: string; slug: string; loaded: Loaded; membership: Organization | null }) {
  const navigate = useNavigate();
  const [query, setQuery] = useSearchParams();
  const { user } = useAuth();
  const { composition, versions } = loaded;
  const reader = user?.id ?? 'anonymous';
  const picked = pickVersion(versions, query.get('version'));
  const shown = useResource<CompositionVersionView | null>(
    `showcase-version:${reader}:${org}/${slug}/${picked?.id ?? 'none'}`,
    async () => (picked ? compositionsApi.version(org, slug, picked.id, { document: true }) : null),
  );
  const version = shown.data ?? null;
  const model = compositionViewModel({ composition, version, reader: membership ? 'member' : 'public' });

  // Fork asks a visitor to sign in first, and the sign-in comes back here with `?fork=1`: the dialog then opens once, and the
  // address forgets the request so a reload does not open it again.
  const wantsFork = query.get('fork') === '1';
  const [forkAsked, setForkAsked] = useState(wantsFork);
  const [forking, setForking] = useState(false);
  const forkOpen = version !== null && user !== null && (forking || forkAsked);
  useEffect(() => {
    if (!wantsFork || !user || !version) return;
    setQuery((current) => {
      const next = new URLSearchParams(current);
      next.delete('fork');
      return next;
    }, { replace: true });
  }, [wantsFork, user, version, setQuery]);

  const fork = () => {
    if (user) {
      setForking(true);
      return;
    }
    void navigate('/login', { state: { from: showcasePath(org, slug, { version: picked?.label, fork: true }) } });
  };
  const closeFork = () => {
    setForking(false);
    setForkAsked(false);
  };

  const versionFailure = shown.status === 'error' ? classifyAuthError(shown.error) : null;
  const permalink = `${window.location.origin}${showcasePath(org, slug, { version: picked?.label })}`;

  return (
    <>
      {composition.visibility === 'private' && (
        <Notice tone="info" title="Only members see this page">
          This composition is private: anybody outside {composition.organization.name} who opens this address is told there is no composition here.
        </Notice>
      )}
      {versionFailure && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={shown.reload}>Retry</Action>}>
          {`Version ${picked?.label ?? ''} couldn’t be loaded${marker(versionFailure)}.`}
        </Notice>
      )}
      {picked && shown.status === 'loading' ? (
        <div role="status" aria-busy="true" className="pcs-loading">
          <span className="sr-only">Loading the version…</span>
          <Skeleton variant="panel" /><Skeleton variant="card" />
        </div>
      ) : (
        <CompositionRenderer
          model={model}
          mode="showcase"
          showcase={{
            versions: versions.map((item) => ({ id: item.id, label: item.label, createdAt: item.created_at })),
            versionHref: (label) => showcasePath(org, slug, { version: label }),
            permalink,
            updatedAt: composition.updated_at,
            onFork: version ? fork : undefined,
            appHref: membership ? compositionPath(org, slug, undefined, { version: picked?.label }) : null,
          }}
        />
      )}
      {forkOpen && version && <ForkCompositionDialog composition={composition} version={version} onClose={closeFork} />}
    </>
  );
}

/**
 * The public page of a composition (`pub-showcase`, `/c/:org/:composition`): what its documents say, at the version `?version=` names
 * (an id, a label or an ordinal; the latest when none, or when the one named is not listed). Anybody reads a public composition here;
 * a member of its organization reads a private one too, told so, and is offered the composition in the app. Fork takes the version
 * shown into an organization of the reader's: a visitor signs in first and comes back with `?fork=1`. Nothing else is done here: a
 * reader who is not a member only reads (C3).
 */
export function Showcase() {
  const { org = '', composition: slug = '' } = useParams();
  const { user } = useAuth();
  const reader = user?.id ?? 'anonymous';
  const content = useResource<Loaded>(`showcase:${reader}:${org}/${slug}`, async () => {
    const [read, versions] = await Promise.all([
      compositionsApi.get(org, slug),
      compositionsApi.allVersions(org, slug, { order: 'newest' }),
    ]);
    return { composition: read.value, versions };
  });
  // The reader's organizations, to know whether the composition's is one of them; a failed read only means "not a member".
  const organizations = useResource<Organization[]>(
    `showcase-organizations:${reader}`,
    async () => (user ? platformApi.organizations().catch(() => []) : []),
  );
  const membership = organizations.data?.find((item) => item.slug === org && item.effective_role !== null) ?? null;
  const failure = content.status === 'error' ? classifyAuthError(content.error) : null;
  const missing = failure !== null && (failure.status === 404 || failure.status === 403 || failure.kind === 'not-found');

  return (
    <div className="pcs-page">
      <Link className="pcs-back" to={publicCompositionsPath()} viewTransition>
        <ArrowLeft aria-hidden="true" />
        Public compositions
      </Link>
      {content.status === 'loading' && (
        <div role="status" aria-busy="true" className="pcs-loading">
          <span className="sr-only">Loading the composition…</span>
          <Skeleton variant="panel" /><Skeleton variant="card" />
        </div>
      )}
      {missing && <ShowcaseMissing />}
      {failure && !missing && (
        <Gate title={`The composition couldn’t be loaded${marker(failure)}`} action={<Action variant="primary" onClick={content.reload}>Try again</Action>}>
          The gateway didn’t answer for this composition. This says nothing about who may read it. Try again in a moment.
        </Gate>
      )}
      {content.data && (
        <ShowcaseBody key={`${reader}:${org}/${slug}`} org={org} slug={slug} loaded={content.data} membership={membership} />
      )}
    </div>
  );
}
