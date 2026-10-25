import { decisionReceipt, formatNumber as fmt, shortId } from '../../analysis/archive';
import { Notice } from '../../components/ui/Notice';
import './SavedDecision.css';

/**
 * The decision a report recorded: which binding was chosen, its score and where each loss came from. Reports are editable
 * documents, so the snapshot is checked before it is drawn; one that doesn't hold up says so instead of showing half of it.
 */
export function SavedDecision({ document: raw }: { document: unknown }) {
  const receipt = decisionReceipt(raw);
  if (!receipt) return <Notice tone="error">This report holds an invalid decision snapshot. Open “View source” to inspect its document.</Notice>;
  return (
    <div className="an-saved">
      <p className="an-saved-scope">{receipt.scope}</p>
      {receipt.selected.map((selected) => (
        <article key={selected.row.id} className="an-saved-card">
          <header>
            <h3>Binding {shortId(selected.row.id)}</h3>
            <span>Recorded score {selected.row.score?.map(fmt).join(' / ') ?? 'not eligible'}</span>
          </header>
          <p>{selected.explanation.formula}</p>
          <ul className="an-contribs" aria-label={`What contributed to binding ${shortId(selected.row.id)}`}>
            {selected.explanation.components.map((component) => (
              <li key={component.key}>
                <span>{component.key}</span>
                <span className="an-meter" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.min(100, (component.normalized ?? 0) * 100))}%` }} /></span>
                <small>{fmt(component.value)} · priority {fmt(component.weight)}</small>
              </li>
            ))}
          </ul>
          {selected.binding && (
            <dl className="an-assignment">
              {Object.entries(selected.binding).map(([task, ref]) => (
                <div key={task}><dt>{task}</dt><dd>{typeof ref?.resource === 'string' && typeof ref?.id === 'string' ? ref.id : 'unrecognised reference'}</dd></div>
              ))}
            </dl>
          )}
        </article>
      ))}
    </div>
  );
}
