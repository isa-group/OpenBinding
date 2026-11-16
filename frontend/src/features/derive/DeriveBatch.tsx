import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { compositionsApi } from '../../entities/composition/api';
import type { Kind } from '../../entities/composition/document';
import { KIND_OPTIONS } from '../../entities/composition/kinds';
import { compositionPath } from '../../routes/paths/compositions';
import { readApiError } from '../../shared/api/errors';
import type { DeriveResult } from '../../shared/api/types';
import { SLUG_PATTERN } from '../../shared/lib/slug';
import { FIRST_LABEL, batchSlugErrors, runDerivation, type FrontPoint } from './deriveModel';
import { refusalOf } from './refusal';

/** A point's composition once it holds the point as its first version. */
export interface DerivedPoint {
  slug: string;
  name: string;
  version: { id: string; label: string };
  /** A new version (201); false when the version already held this point's document (a retry, or an earlier batch). */
  created: boolean;
}

type RowState =
  | { status: 'waiting' }
  | { status: 'creating' }
  | { status: 'deriving' }
  | { status: 'done'; derived: DerivedPoint; adopted: boolean }
  | { status: 'failed'; message: string };

interface Row {
  point: FrontPoint;
  slug: string;
  state: RowState;
}

/** The composition a point's derivation found at its address already, when it may take it: an empty one, or the one it made. */
type Found = 'empty' | 'same' | 'other';

/**
 * Whether the composition at `slug` is this point's: one with no version yet (an earlier attempt created it and stopped), or one
 * whose 1.0.0 was derived from this run and solution. Anything else, or a read that fails, is another composition's address.
 */
async function foundAt(org: string, slug: string, point: FrontPoint): Promise<Found> {
  try {
    const found = await compositionsApi.get(org, slug);
    if (!found.value.latest_version) return 'empty';
    const first = await compositionsApi.version(org, slug, FIRST_LABEL);
    return first.derivation?.run?.id === point.run && first.derivation.point === point.point
      ? 'same'
      : 'other';
  } catch {
    return 'other';
  }
}

const isSealed = (result: unknown): result is DeriveResult =>
  typeof result === 'object' && result !== null && 'version' in result;

function stateText(state: RowState): string {
  switch (state.status) {
    case 'waiting':
      return 'Not derived yet.';
    case 'creating':
      return 'Creating the composition…';
    case 'deriving':
      return `Deriving ${FIRST_LABEL}…`;
    case 'done':
      return state.derived.created
        ? `${state.adopted ? 'Derived into the composition already at this address' : 'Created'}; ${state.derived.version.label} sealed.`
        : `${state.derived.version.label} already held this point.`;
    case 'failed':
      return state.message;
  }
}

/** What the batch did, exactly: how many points hold a composition, and which failed and why. */
function summaryOf(rows: readonly Row[]): string {
  const done = rows.filter(row => row.state.status === 'done').length;
  const failed = rows.filter(
    (row): row is Row & { state: { status: 'failed'; message: string } } =>
      row.state.status === 'failed'
  );
  const head = `${done} of ${rows.length} ${rows.length === 1 ? 'point holds' : 'points hold'} a composition.`;
  if (failed.length === 0) return head;
  return `${head} ${failed.length} failed: ${failed.map(row => `${row.point.label} (${row.slug}): ${row.state.message}`).join(' ')}`;
}

interface DeriveBatchProps {
  org: string;
  points: readonly FrontPoint[];
  onClose: () => void;
  onDerived?: (key: string, derived: DerivedPoint) => void;
}

/**
 * The batch mode of the derive dialog (C5, D16): each point of a study front becomes a new composition whose version 1.0.0 is the
 * point's solution. The addresses can be edited first. The points are derived one after another, never at once, and each reports
 * its own result; a failure stops nobody else. Retrying is safe: a composition the batch made is not made again, deriving is
 * idempotent (a version that already holds the document answers 200), and an address that is taken is taken over only when its
 * composition is empty or already holds this very point.
 */
export function DeriveBatch({ org, points, onClose, onDerived }: DeriveBatchProps) {
  const ids = useId();
  const [rows, setRows] = useState<Row[]>(() =>
    points.map(point => ({ point, slug: point.slug, state: { status: 'waiting' } }))
  );
  const [kind, setKind] = useState<Kind>('application');
  const [running, setRunning] = useState(false);
  const [checked, setChecked] = useState(false);
  /** The compositions this batch created, by point key: a retry derives into them instead of creating them again. */
  const made = useRef(new Map<string, string>());

  const update = (key: string, change: Partial<Row>) =>
    setRows(now => now.map(row => (row.point.key === key ? { ...row, ...change } : row)));
  const pending = rows.filter(row => row.state.status !== 'done');
  const errors = batchSlugErrors(
    rows.map(row => ({ key: row.point.key, slug: row.slug })),
    SLUG_PATTERN
  );
  const started = rows.some(row => row.state.status !== 'waiting');

  /** One point: its composition (created, or the one found at its address when that is its own), then its 1.0.0. */
  const deriveOne = async (row: Row): Promise<void> => {
    const { point, slug } = row;
    let adopted = false;
    if (made.current.get(point.key) !== slug) {
      update(point.key, { state: { status: 'creating' } });
      try {
        await compositionsApi.create(org, { slug, name: point.name, kind, description: '' });
        made.current.set(point.key, slug);
      } catch (caught) {
        if (readApiError(caught).code !== 'slug_conflict') {
          update(point.key, {
            state: { status: 'failed', message: refusalOf(caught, 'create', 'run').message },
          });
          return;
        }
        if ((await foundAt(org, slug, point)) === 'other') {
          update(point.key, {
            state: {
              status: 'failed',
              message: `${slug} is another composition’s address in this organization. Choose another address.`,
            },
          });
          return;
        }
        made.current.set(point.key, slug);
        adopted = true;
      }
    }
    update(point.key, { state: { status: 'deriving' } });
    try {
      const answer = await compositionsApi.derive(
        org,
        slug,
        runDerivation(point, point.point, FIRST_LABEL, true)
      );
      if (!isSealed(answer.result)) throw new Error('The gateway answered a preview to a seal.');
      const derived: DerivedPoint = {
        slug,
        name: point.name,
        version: { id: answer.result.version.id, label: answer.result.version.label },
        created: answer.created,
      };
      update(point.key, { state: { status: 'done', derived, adopted } });
      onDerived?.(point.key, derived);
    } catch (caught) {
      const error = readApiError(caught);
      const message =
        error.code === 'version_label_taken'
          ? `${FIRST_LABEL} of ${slug} already holds another document. Choose another address.`
          : refusalOf(caught, 'derive', 'run').message;
      update(point.key, { state: { status: 'failed', message } });
    }
  };

  const start = async () => {
    setChecked(true);
    if (running || Object.keys(errors).some(key => pending.some(row => row.point.key === key)))
      return;
    setRunning(true);
    // One after another, in the order of the front: the gateway's derive budget is shared, and the report reads in that order.
    for (const row of pending) await deriveOne(row);
    setRunning(false);
  };

  const close = () => {
    if (!running) onClose();
  };
  const allDone = pending.length === 0;
  const startLabel = !started
    ? `Derive ${rows.length} ${rows.length === 1 ? 'composition' : 'compositions'}`
    : `Retry ${pending.length} ${pending.length === 1 ? 'point' : 'points'}`;

  return (
    <Modal title="Derive compositions" size="lg" onClose={close} dismissible={!running}>
      <div className="dc">
        <p className="dc-muted">
          {`Each point becomes a new composition of this organization, with the point’s solution as its version ${FIRST_LABEL}. `}
          The compositions are created and derived one after another; change an address before you
          start.
        </p>
        {!started && (
          <div className="ui-field">
            <label htmlFor={`${ids}-kind`}>Kind</label>
            <select
              id={`${ids}-kind`}
              className="dc-select"
              value={kind}
              onChange={event => setKind(event.target.value as Kind)}
            >
              {KIND_OPTIONS.map(option => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <ol className="dc-batch" aria-label="Points to derive">
          {rows.map(row => {
            const editable = !running && row.state.status !== 'done';
            const { state } = row;
            return (
              <li key={row.point.key} className={`dc-batch-row is-${state.status}`}>
                <p className="dc-batch-head">
                  <strong>{row.point.label}</strong>{' '}
                  <span className="dc-muted">{row.point.detail}</span>
                </p>
                <FormField
                  label={`Address of ${row.point.label}`}
                  value={row.slug}
                  disabled={!editable}
                  spellCheck={false}
                  mono
                  error={checked || row.slug !== row.point.slug ? errors[row.point.key] : undefined}
                  onChange={event =>
                    update(row.point.key, {
                      slug: event.target.value,
                      state: state.status === 'failed' ? state : { status: 'waiting' },
                    })
                  }
                />
                <p className="dc-batch-state" aria-label={`Result of ${row.point.label}`}>
                  {stateText(state)}
                  {state.status === 'done' && (
                    <>
                      {' '}
                      <Link
                        to={compositionPath(org, state.derived.slug, 'versions', {
                          version: state.derived.version.label,
                        })}
                      >
                        {`Open ${state.derived.slug} ${state.derived.version.label}`}
                      </Link>
                    </>
                  )}
                </p>
              </li>
            );
          })}
        </ol>
        <p className="dc-muted" role="status">
          {running ? 'Deriving…' : started ? summaryOf(rows) : ''}
        </p>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={close} disabled={running}>
            {allDone ? 'Done' : 'Cancel'}
          </Action>
          {!allDone && (
            <Action variant="primary" busy={running} onClick={() => void start()}>
              {startLabel}
            </Action>
          )}
        </div>
      </div>
    </Modal>
  );
}
