import { useMemo, useState } from 'react';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';
import {
  candidateMatrix,
  type MatrixCandidate,
  type MatrixCell,
} from '../../../core/utils/binding/candidateMatrix';
import { resourcePaths } from '../../../core/diagnostics/bim';
import type { Located } from '../../../core/diagnostics/located';
import { formatFeature, type FeatureSlot } from '../../../core/utils/featureRange';
import { CandidateMatrix } from '../../../core/components/candidate-matrix/CandidateMatrix';
import { ValueBadge } from '../../../core/components/value-badge/ValueBadge';
import { instanceResources, parseJson, pretty, type WorkspaceFiles } from '../../utils/documents';
import { FeatureCell } from '../feature-cell';
import { CandidateCatalogForm } from '../resource-forms';
import {
  cellFindings,
  isPending,
  parsedDocuments,
  sourceValue,
  type CellOrigin,
} from '../../utils/matrixEdits';
import { NotChecked, StaleNote, type ModelProps } from '../model-panes';
import { addCandidate, packageContext } from '../../utils/packageContext';
import { FIELD, LINK, MUTED, NOTE, PANE, RESOURCE_FORM } from '../../utils/styles';

const FINDING_TONE = {
  error: 'text-tp-error-text',
  warning: 'text-tp-warning-text',
  info: 'text-tp-steel',
} as const;

/** A candidate as its catalog writes it: the catalog's file and the candidate's id in it. */
interface CandidatePlace {
  path: string;
  id: string;
}

interface CandidatesPaneProps extends ModelProps {
  /** The task shown alone; null shows every task. */
  task: string | null;
  onTask: (task: string | null) => void;
  /** The files of the package as they are now (what an edit writes to and what a cell reads back). */
  files: WorkspaceFiles;
  /** The findings of the last check. */
  diagnostics: readonly Located[];
  /** Write a value where the package writes it (`null` removes it), as one undo step. */
  onEdit: (origin: CellOrigin, value: FeatureSlot | null) => void;
  /** Change the files as one undo step (the side panel's form). */
  update: (updater: (current: WorkspaceFiles) => WorkspaceFiles) => void;
  onOpenFile: (path: string) => void;
  /** Show a finding where it is (the file at its range). */
  onOpenFinding: (finding: Located) => void;
}

/**
 * The candidates of each task of the last valid package, the matrix the problem page draws, with every value editable in place
 * (D9). The rows and the candidates are the last check's facts: a candidate added to a catalog appears after the next check, and
 * the browser never decides which task can take it. A value is read from, and written to, the place its origin names in the
 * package; a cell whose source no longer agrees with the last check is pending until the next one, and the check's findings about
 * a value are shown on its cell. A candidate's name opens its catalog form (providers, capabilities, values) beside the matrix.
 */
export function CandidatesPane({
  facts,
  stale,
  selection,
  task,
  onTask,
  files,
  diagnostics,
  onEdit,
  update,
  onOpenFile,
  onOpenFinding,
}: CandidatesPaneProps) {
  const [editing, setEditing] = useState(true);
  const [panel, setPanel] = useState<CandidatePlace | null>(null);
  const matrix = useMemo(
    () => (facts ? candidateMatrix(facts, { selection }) : null),
    [facts, selection]
  );
  const documents = useMemo(() => parsedDocuments(files), [files]);
  const resources = useMemo(
    () => instanceResources(parseJson(files['instance.json']), files),
    [files]
  );
  const catalogs = resources.filter(
    resource => resource.kind === 'CandidateCatalog' && resource.path
  );
  // Where each candidate of the facts is written: the file of its values, else the file the Instance gives its catalog.
  const places = useMemo(() => {
    const ids = resourcePaths(files);
    const found = new Map<string, CandidatePlace>();
    for (const candidate of facts?.candidates ?? []) {
      const path = Object.values(candidate.origins)[0]?.path ?? ids[candidate.resource];
      if (path) found.set(candidate.key, { path, id: candidate.id });
    }
    return found;
  }, [facts, files]);

  if (!facts || !matrix) return <NotChecked what="The candidates of each task appear" />;
  const imported = facts.candidates.reduce(
    (count, candidate) =>
      count + Object.values(candidate.origins).filter(origin => origin.source).length,
    0
  );
  const shown =
    task && matrix.rows.some(row => row.task === task)
      ? { ...matrix, rows: matrix.rows.filter(row => row.task === task) }
      : matrix;
  const placeOf = (candidate: MatrixCandidate) => places.get(candidate.key) ?? null;
  const isOpen = (place: CandidatePlace | null) =>
    place !== null && panel !== null && place.path === panel.path && place.id === panel.id;

  const add = (path: string) => {
    const document = parseJson(files[path]);
    if (!document) return;
    const added = addCandidate(document.spec ?? {});
    update(current => ({ ...current, [path]: pretty({ ...document, spec: added.spec }) }));
    setPanel({ path, id: added.id });
  };

  const renderName = (candidate: MatrixCandidate) => {
    const place = placeOf(candidate);
    if (!place) return <code className="font-mono">{candidate.written}</code>;
    return (
      <button
        type="button"
        className="cursor-pointer text-left text-tp-link underline aria-expanded:font-semibold aria-expanded:text-tp-primary-deep"
        aria-expanded={isOpen(place)}
        aria-label={`Edit candidate ${candidate.written}`}
        onClick={() => setPanel(isOpen(place) ? null : place)}
      >
        <code className="font-mono">{candidate.written}</code>
      </button>
    );
  };

  const renderCell = (cell: MatrixCell, candidate: MatrixCandidate) => {
    const origin = cell.origin;
    if (!origin) {
      const place = placeOf(candidate);
      return (
        <span className="flex min-w-0 flex-col items-start gap-1">
          <span className="text-xs text-tp-steel">not declared</span>
          {place && (
            <button
              type="button"
              className={LINK}
              onClick={() => setPanel(place)}
              aria-label={`Add ${cell.feature} for ${candidate.written}`}
            >
              Add a value
            </button>
          )}
        </span>
      );
    }
    const source = sourceValue(documents, origin);
    const findings = cellFindings(diagnostics, origin);
    if (source.kind === 'unreadable' || source.kind === 'other') {
      return (
        <span className="flex min-w-0 flex-col items-start gap-1">
          <span>{formatFeature(cell.value, { unit: cell.unit !== '1' ? cell.unit : null })}</span>
          <button type="button" className={LINK} onClick={() => onOpenFile(origin.path)}>
            {source.kind === 'unreadable'
              ? `Repair ${origin.path} in Files to edit it`
              : `Edit it in ${origin.path}`}
          </button>
        </span>
      );
    }
    const pending = isPending(cell.value, source);
    const imported = origin.source ?? null;
    return (
      <div
        className="group flex min-w-0 flex-col items-start gap-1"
        data-pending={pending || undefined}
      >
        <FeatureCell
          feature={cell.feature}
          candidate={candidate.written}
          value={source.kind === 'value' ? source.value : undefined}
          onChange={value => onEdit(origin, value)}
        />
        {imported && (
          <span className="pe-imported hidden max-w-[220px] text-[11px] whitespace-normal text-tp-warning-text group-focus-within:inline">
            Comes from SPHERE; editing makes it a hand-written value.
          </span>
        )}
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <ValueBadge origin={origin} compact />
          {pending && (
            <span className="rounded-full border border-dashed border-tp-severity-warning px-1.5 text-[11px] font-semibold whitespace-nowrap text-tp-ink-tint">
              Pending check
            </span>
          )}
        </span>
        {findings.map((finding, index) => (
          <button
            key={`${finding.code}-${index}`}
            type="button"
            className={`max-w-[220px] cursor-pointer text-left text-[11px] whitespace-normal underline ${FINDING_TONE[finding.severity]}`}
            onClick={() => onOpenFinding(finding)}
          >
            {finding.message}
          </button>
        ))}
      </div>
    );
  };

  const known = panel
    ? facts.candidates.some(
        candidate => places.get(candidate.key)?.path === panel.path && candidate.id === panel.id
      )
    : false;

  return (
    <div className={PANE}>
      {stale && <StaleNote />}
      <div className="flex flex-wrap items-end gap-2">
        <label className={`${FIELD} flex-[0_1_14rem]`}>
          <span>Task</span>
          <select
            aria-label="Task"
            value={shown === matrix ? '' : (task ?? '')}
            onChange={event => onTask(event.target.value || null)}
          >
            <option value="">All tasks</option>
            {matrix.rows.map(row => (
              <option key={row.task} value={row.task}>
                {row.task}
              </option>
            ))}
          </select>
        </label>
        <Action
          size="sm"
          variant="ghost"
          aria-pressed={editing}
          className="aria-pressed:bg-tp-surface-cream aria-pressed:text-tp-primary-deep"
          onClick={() => setEditing(value => !value)}
        >
          Edit values
        </Action>
        {catalogs.map(catalog => (
          <Action key={catalog.id} size="sm" variant="secondary" onClick={() => add(catalog.path!)}>
            {catalogs.length === 1 ? 'Add a candidate' : `Add a candidate to ${catalog.id}`}
          </Action>
        ))}
      </div>
      {editing && (
        <p className={MUTED}>
          Each value is written where the package declares it. An edited value is pending until the
          next check; a new candidate appears under the tasks that can take it after the next check.
        </p>
      )}
      {editing && imported > 0 && (
        <Notice tone="info">
          {`${imported === 1 ? 'One value comes' : `${imported} values come`} from SPHERE (marked Priced, Guarantee, Limit, Feature or Manual). Editing one makes it a hand-written value: the next version no longer says where it came from.`}
        </Notice>
      )}
      <div
        className={
          panel
            ? 'grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(280px,26rem)]'
            : 'grid grid-cols-1 items-start gap-4'
        }
      >
        <CandidateMatrix
          matrix={shown}
          mode={editing ? 'edit' : 'view'}
          renderCell={renderCell}
          renderName={renderName}
          label="Candidates of each task"
        />
        {panel && (
          <CandidatePanel
            place={panel}
            known={known}
            files={files}
            update={update}
            onOpenFile={onOpenFile}
            onClose={() => setPanel(null)}
          />
        )}
      </div>
    </div>
  );
}

/** One candidate's catalog form: the providers it can point to, its capabilities, provider and values, and the values it misses. */
function CandidatePanel({
  place,
  known,
  files,
  update,
  onOpenFile,
  onClose,
}: {
  place: CandidatePlace;
  /** The last check has this candidate (a new one has not been checked yet). */
  known: boolean;
  files: WorkspaceFiles;
  update: CandidatesPaneProps['update'];
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const document = parseJson(files[place.path]);
  const resources = instanceResources(parseJson(files['instance.json']), files);
  const context = packageContext(files, resources, place.path, { open: onOpenFile, update });
  const present = Boolean(document?.spec?.candidates?.[place.id]);
  return (
    <aside
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-tp-hairline bg-tp-canvas p-3"
      aria-labelledby="pe-candidate-title"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 id="pe-candidate-title" className="text-[15px] font-semibold text-tp-ink">
          Candidate <code className="font-mono">{place.id}</code>
        </h3>
        <span className={MUTED}>
          in <code className="font-mono">{place.path}</code>
        </span>
        <Action size="sm" variant="ghost" onClick={onClose} className="ml-auto">
          Close
        </Action>
      </div>
      {!document ? (
        <Notice
          tone="error"
          action={
            <button type="button" className={LINK} onClick={() => onOpenFile(place.path)}>
              Open {place.path} in Files
            </button>
          }
        >
          {`${place.path} is not a JSON document right now, so the candidate has no form. Repair its text in Files.`}
        </Notice>
      ) : (
        <>
          {present && !known && (
            <p
              className={NOTE}
              role="note"
            >{`${place.id} is not in the matrix yet: it appears after the next check, under the tasks that can take it.`}</p>
          )}
          {!present && known && (
            <p
              className={NOTE}
              role="note"
            >{`${place.id} was removed from ${place.path}; it leaves the matrix after the next check.`}</p>
          )}
          <div className={RESOURCE_FORM}>
            <CandidateCatalogForm
              spec={document.spec ?? {}}
              updateSpec={spec =>
                update(current => ({ ...current, [place.path]: pretty({ ...document, spec }) }))
              }
              context={context}
              candidate={place.id}
            />
          </div>
        </>
      )}
    </aside>
  );
}
