import { Component, type ReactNode } from 'react';
import { Check, Minus } from 'lucide-react';
import { PricingRenderer } from 'pricing-renderer/react';
import 'pricing-renderer/styles.css';
import { Notice } from '../../components/ui/Notice';
import { Tag } from './AdminChrome';
import { humanize } from './adminModel';
import {
  HEADLINE_LIMITS, booleanFeatures, limitLabel, limitText, orderedLimits, priceLabel,
  type Change, type PricingDoc, type ServerValidation,
} from './pricingModel';
import './AdminPricing.css';

class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed
      ? <Notice tone="warning" title="The customer preview couldn’t be rendered">The renderer couldn’t read this document. The plans above are read from the same document and are not affected.</Notice>
      : this.props.children;
  }
}

/** How the public pricing page would draw this document, with its own renderer. A document it can’t draw says so instead of breaking the page. */
export function PricingPreview({ yaml }: { yaml: string }) {
  return (
    <PreviewBoundary>
      <PricingRenderer yaml={yaml} locale="en-US" pricingPath="/pricing" theme="light" selectionEnabled={false} ctaEnabled={false} />
    </PreviewBoundary>
  );
}

/** The plans of a document as cards: price, what each includes beyond the others, and the headline limits. */
export function PlanCards({ doc, highlight }: { doc: PricingDoc; highlight?: string }) {
  const features = booleanFeatures(doc);
  const inEvery = features.filter((def) => doc.plans.every((plan) => plan.features[def.id] === true));
  const shown = orderedLimits(doc).filter((def) => (HEADLINE_LIMITS as readonly string[]).includes(def.id));
  return (
    <>
    <div className="apr-plans" role="list" aria-label="Plans">
      {doc.plans.map((plan) => {
        const extra = features.filter((def) => plan.features[def.id] === true && !inEvery.includes(def));
        return (
          <div key={plan.id} role="listitem" aria-label={plan.id} className={`apr-plan${plan.id === highlight ? ' is-highlight' : ''}`}>
            <strong>{plan.id}</strong>
            <span className="apr-plan-price">{priceLabel(plan.price, doc.currency)}</span>
            {plan.description && <span className="adm-muted">{plan.description.replace(/^Contact us \/ Institutional agreement\.?\s*/i, '')}</span>}
            <span className="apr-chips">
              {extra.map((def) => <Tag key={def.id} tone="info">{humanize(def.id)}</Tag>)}
              {extra.length === 0 && <span className="adm-muted">No extra features</span>}
            </span>
            <dl className="apr-plan-limits">
              {shown.map((def) => (
                <div key={def.id}><dt>{limitLabel(doc, def.id)}</dt><dd>{limitText(doc, def.id, plan.limits[def.id])}</dd></div>
              ))}
            </dl>
          </div>
        );
      })}
    </div>
    {inEvery.length > 0 && (
      <p className="adm-muted">Every plan includes {inEvery.map((def) => humanize(def.id).toLowerCase()).join(', ')}.</p>
    )}
    </>
  );
}

/** Every difference between two documents, grouped by plan, with the figure before and after. */
export function ChangeList({ changes, label }: { changes: Change[]; label: string }) {
  if (changes.length === 0) return null;
  const groups = [...new Set(changes.map((change) => change.plan ?? 'Add-ons'))];
  return (
    <div className="apr-changes" role="group" aria-label={label}>
      {groups.map((group) => (
        <div key={group} className="apr-change-group">
          <h3>{group}</h3>
          <div className="ui-table-wrap">
            <table className="ui-table" aria-label={`${group}: ${label}`}>
              <thead>
                <tr><th scope="col">What</th><th scope="col">Before</th><th scope="col">After</th></tr>
              </thead>
              <tbody>
                {changes.filter((change) => (change.plan ?? 'Add-ons') === group).map((change) => (
                  <tr key={change.id} className={`is-${change.direction}`}>
                    <th scope="row">{change.label}</th>
                    <td>{change.before}</td>
                    <td className="apr-after">{change.after}{change.direction === 'up' ? ' ▲' : change.direction === 'down' ? ' ▼' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/** What the gateway found in a document: its verdict, what it read, and each error or warning. */
export function ValidationPanel({ validation, client }: { validation: ServerValidation; client: string | null }) {
  const facts: Array<[string, string]> = [
    ['Verdict', validation.valid ? 'Ready' : 'Blocked'],
    ['Version', validation.version ?? '—'],
    ['Plans', validation.plans.length > 0 ? validation.plans.join(' · ') : '—'],
    ['Add-ons', String(validation.addOns.length)],
  ];
  return (
    <div className="apr-validation">
      <div className="apr-facts" role="list" aria-label="What the gateway read">
        {facts.map(([name, value]) => (
          <div key={name} role="listitem" className={name === 'Verdict' ? `is-${validation.valid ? 'ok' : 'blocked'}` : undefined}>
            <span>{name}</span><strong>{value}</strong>
          </div>
        ))}
      </div>
      {validation.digest && <p className="adm-muted">Fingerprint <span className="is-mono">{validation.digest}</span></p>}
      <ul className="apr-diagnostics" aria-label="Diagnostics">
        {client && <li className="is-note"><Tag>Pricing4TS</Tag><span>{client}</span></li>}
        {validation.errors.map((text) => <li key={`e-${text}`} className="is-error"><Tag tone="error">Error</Tag><span>{text}</span></li>)}
        {validation.warnings.map((text) => <li key={`w-${text}`} className="is-warning"><Tag tone="warning">Warning</Tag><span>{text}</span></li>)}
        {validation.valid && validation.errors.length === 0 && <li className="is-ok"><Tag tone="success"><Check aria-hidden="true" />Valid</Tag><span>The gateway accepts this document.</span></li>}
        {!validation.valid && validation.errors.length === 0 && <li className="is-error"><Tag tone="error"><Minus aria-hidden="true" />Blocked</Tag><span>The gateway didn’t accept this document.</span></li>}
      </ul>
    </div>
  );
}
