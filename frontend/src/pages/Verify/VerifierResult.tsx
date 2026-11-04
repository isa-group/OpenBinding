import { Check, CircleHelp, Info, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { VerifierEntity, VerifierStatus, VerifierVerdict } from '../../api/platform';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { useCopy } from '../../components/ui/useCopy';
import { SourceView } from '../../components/rendering/SourceView';
import { buildCitation } from '../../utils/citation';
import { yearOf } from '../../utils/format';
import type { Result } from './verifierChecks';
import { entityHref, entityKind } from './verifierOptions';

const VERDICTS: Record<VerifierStatus, { title: string; text: string; tone: 'ok' | 'info' | 'bad' | 'plain'; Icon: typeof Check }> = {
  verified: { title: 'Verified', text: 'The fingerprint is what OpenBinding recorded.', tone: 'ok', Icon: Check },
  computed: { title: 'Computed, not on record', text: 'We computed its fingerprint, but OpenBinding hasn’t recorded anything with it. That’s normal for drafts or local files.', tone: 'info', Icon: Info },
  mismatch: { title: 'Doesn’t match', text: 'The content you gave hashes differently from the fingerprint you expected. It was changed somewhere along the way.', tone: 'bad', Icon: TriangleAlert },
  not_found: { title: 'Nothing found', text: 'OpenBinding has no element recorded with this fingerprint that you can see. Someone else’s private item reads exactly like one that was never registered, so this doesn’t say which it is.', tone: 'plain', Icon: CircleHelp },
};

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

function Matches({ entities, digest }: { entities: VerifierEntity[]; digest: string }) {
  return (
    <section className="rp-card" aria-labelledby="vf-matches-title">
      <h2 id="vf-matches-title">Matches</h2>
      {entities.length === 0 && <p className="rp-muted">No element is recorded with this fingerprint.</p>}
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
    </section>
  );
}

function CitationCard({ verdict, entity }: { verdict: VerifierVerdict; entity: VerifierEntity }) {
  const { copy, status } = useCopy();
  const kind = entityKind(entity.entity_type);
  const origin = window.location.origin;
  // The permanent-link forms: what a publication cites and what the gateway's citation points to.
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

/** What the verifier answered: the verdict, the fingerprints, the matches, a citation and the canonical JSON behind a disclosure. */
// [impl->req~frontend-nav-verify-no-raw-json~1]
export function VerifierResult({ result }: { result: Result }) {
  const { verdict } = result;
  const verdictWords = VERDICTS[verdict.status];
  const entities = verdict.entities ?? [];
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
      {(verdict.status === 'verified' || entities.length > 0) && <Matches entities={entities} digest={verdict.digest} />}
      {verdict.status === 'verified' && entities[0] && <CitationCard verdict={verdict} entity={entities[0]} />}
      {verdict.canonical_json && (
        <details className="rp-source">
          <summary>Canonical JSON</summary>
          <SourceView source={verdict.canonical_json} label="Canonical JSON" language="json" />
        </details>
      )}
    </>
  );
}
