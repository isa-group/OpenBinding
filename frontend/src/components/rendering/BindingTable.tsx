import { DataTable } from '../ui/DataTable';
import { formatFeature } from '../../utils/featureRange';
import type { BindingFeature, BindingRow, BindingValue } from './bindingTableModel';
import './BindingTable.css';

interface BindingTableProps {
  rows: BindingRow[];
  /** Column order; missing or empty means no feature column. */
  features?: BindingFeature[];
  label?: string;
}

const NO_FEATURES: BindingFeature[] = [];

function Missing() {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">no value</span>
    </>
  );
}

/** A name followed by its id, or the id alone when there is no distinct name. */
function Named({ name, id }: { name: string; id: string }) {
  return name === id ? <code>{id}</code> : <>{name} <code>{id}</code></>;
}

/** The chosen candidate of each task, its provider and its own feature values, in a sideways-scrolling table. */
// [impl->req~frontend-rendering-binding-table~1]
export function BindingTable({ rows, features = NO_FEATURES, label = 'Chosen providers' }: BindingTableProps) {
  if (rows.length === 0) return <p>This solution carries no binding assignment.</p>;
  const withProvider = rows.some((row) => row.provider !== null);

  return (
    <DataTable label={label} minWidth={320 + 120 * features.length}>
      <thead>
        <tr>
          <th scope="col">Task</th>
          <th scope="col">Candidate</th>
          {withProvider && <th scope="col">Provider</th>}
          {features.map((feature) => (
            <th scope="col" key={feature.name}>{feature.unit === null ? feature.name : `${feature.name} (${feature.unit})`}</th>
          ))}
        </tr>
      </thead>
      <tbody className="rendering-binding">
        {rows.map((row) => (
          <tr key={row.task}>
            <th scope="row"><Named name={row.taskName} id={row.task} /></th>
            <td><Named name={row.candidateName} id={row.candidate} /></td>
            {withProvider && <td>{row.provider === null ? <Missing /> : row.provider}</td>}
            {features.map((feature) => {
              const value: BindingValue | null = Object.hasOwn(row.values, feature.name) ? row.values[feature.name] : null;
              return (
                <td key={feature.name} className="rendering-binding__value">
                  {value === null ? <Missing /> : formatFeature(value)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}
