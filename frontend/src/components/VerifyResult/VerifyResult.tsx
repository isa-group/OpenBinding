import { useId, type ReactNode } from 'react';
import { Check, CircleHelp, Info, TriangleAlert } from 'lucide-react';
import type { VerifierEntity, VerifierStatus } from '../../api/platform';
import { Chip } from '../ui/Chip';
import { CopyField } from '../ui/CopyField';
import { Notice } from '../ui/Notice';
import { disagrees, entityName, kindLabelOf, sidesOf, VERDICTS } from './verifyModel';
import './VerifyResult.css';

export interface VerifyResultVerdict {
  status: VerifierStatus;
  digest: string;
  detail?: string | null;
  entities?: VerifierEntity[];
}

export interface VerifyResultProps {
  verdict: VerifyResultVerdict;
  /** The fingerprint the browser computed from a document or file. */
  computed?: string | null;
  /** The fingerprint the person typed. */
  given?: string | null;
  /** Reader's words for entity types (`study_run` → `study run` by default). */
  kindLabels?: Record<string, string>;
  /** An address for an element, or `null`/`undefined` for none; rendered as a plain link. */
  hrefOf?: (entity: VerifierEntity) => string | null | undefined;
  /** A link of the host's router around the element's name; wins over `hrefOf`. */
  renderLink?: (entity: VerifierEntity, label: string) => ReactNode;
  /** Where the host puts its citation panel. */
  citation?: ReactNode;
}

const ICONS: Record<VerifierStatus, typeof Check> = { verified: Check, computed: Info, mismatch: TriangleAlert, not_found: CircleHelp };

/** What a permanent link, a fingerprint or a file resolves to, and whether it matches. */
// [impl->req~verify-result~1]
export function VerifyResult({ verdict, computed, given, kindLabels, hrefOf, renderLink, citation }: VerifyResultProps) {
  const matchesId = useId();
  const words = VERDICTS[verdict.status];
  const Icon = ICONS[verdict.status];
  const entities = verdict.entities ?? [];
  const { left, right } = sidesOf(verdict.status, verdict.digest, entities.length > 0, computed, given);

  return (
    <div className="verify-result">
      <section className={`verify-result__verdict is-${words.tone}`} aria-label="Verdict" aria-live="polite">
        <span className="verify-result__glyph" aria-hidden="true"><Icon size={26} /></span>
        <div>
          <strong>{words.title}</strong>
          <span>{words.text}</span>
          {verdict.detail && <small>{verdict.detail}</small>}
        </div>
      </section>

      {disagrees(verdict.status, verdict.digest, computed) && (
        <Notice tone="warning" title="Your browser and the server disagree">
          They computed different fingerprints for the same input. Don’t rely on either until that is explained.
        </Notice>
      )}

      <div className="verify-result__sides">
        {[left, right].map((side) => (
          <div key={side.label} className="verify-result__side">
            <span className="verify-result__label">{side.label}</span>
            {side.value === null ? <span className="verify-result__none">nothing recorded</span> : <CopyField value={side.value} label={side.label.toLowerCase()} />}
          </div>
        ))}
      </div>

      {entities.length > 0 && (
        <section aria-labelledby={matchesId}>
          <h2 id={matchesId}>Matches</h2>
          <ul className="verify-result__matches">
            {entities.map((entity, index) => {
              const name = entityName(entity);
              const href = renderLink ? null : hrefOf?.(entity);
              return (
                <li key={`${entity.entity_type}:${index}`}>
                  <Chip tone="accent">{kindLabelOf(entity.entity_type, kindLabels)}</Chip>
                  {renderLink ? renderLink(entity, name) : href ? <a href={href}>{name}</a> : <strong>{name}</strong>}
                  {entity.organization_slug && entity.project_slug && <small>{entity.organization_slug} / {entity.project_slug}</small>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {citation}
    </div>
  );
}
