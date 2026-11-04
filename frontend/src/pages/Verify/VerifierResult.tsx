import { Link } from 'react-router-dom';
import type { VerifierEntity } from '../../api/platform';
import { CitationPanel } from '../../components/CitationPanel';
import { VerifyResult, entityName } from '../../components/VerifyResult';
import { SourceView } from '../../components/rendering/SourceView';
import { yearOf } from '../../utils/format';
import type { Result } from './verifierChecks';
import { entityHref, entityKind } from './verifierOptions';

const UNNAMED = 'unnamed element';

const kindLabels = Object.fromEntries(
  ['case', 'snapshot', 'collection', 'report', 'artifact', 'engine', 'study_run'].map((type) => [type, entityKind(type).label]),
);

function renderLink(digest: string) {
  return function EntityLinks(entity: VerifierEntity, label: string) {
    const kind = entityKind(entity.entity_type);
    const href = entityHref(entity);
    return (
      <>
        <strong>{label}</strong>
        <span className="rp-links">
          {href && <Link to={href}>Open</Link>}
          {kind.resolve && <Link to={`/resolve/${kind.resolve}/${digest}`}>Public record</Link>}
        </span>
      </>
    );
  };
}

function Citation({ digest, entity }: { digest: string; entity: VerifierEntity }) {
  const kind = entityKind(entity.entity_type);
  const origin = window.location.origin;
  // The permanent-link forms: what a publication cites and what the gateway's citation points to. On this page the digest is the address.
  const url = kind.resolve ? `${origin}/resolve/${kind.resolve}/${digest}` : `${origin}/app/verifier?digest=${encodeURIComponent(digest)}`;
  // The verdict above already shows the recorded digest as a field, so the panel omits its own digest field; only the permanent link, which is the address, embeds it.
  const name = entityName(entity);
  const kindLabel = kind.label.charAt(0).toLowerCase() + kind.label.slice(1);
  return <CitationPanel title={name === UNNAMED ? kind.label : name} kindLabel={kindLabel} url={url} year={yearOf(entity.created_at)} />;
}

/** What the verifier answered: the verdict, the fingerprints, the matches, a citation and the canonical JSON behind a disclosure. */
// [impl->req~frontend-nav-verify-no-raw-json~1]
export function VerifierResult({ result }: { result: Result }) {
  const { verdict } = result;
  const entity = verdict.entities?.[0];
  return (
    <>
      <VerifyResult
        verdict={verdict}
        computed={result.client}
        given={result.given}
        kindLabels={kindLabels}
        renderLink={renderLink(verdict.digest)}
        citation={verdict.status === 'verified' && entity ? <Citation digest={verdict.digest} entity={entity} /> : undefined}
      />
      {verdict.canonical_json && (
        <details className="rp-source">
          <summary>Canonical JSON</summary>
          <SourceView source={verdict.canonical_json} label="Canonical JSON" language="json" />
        </details>
      )}
    </>
  );
}
