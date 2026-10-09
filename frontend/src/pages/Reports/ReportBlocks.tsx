import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { platformApi, type StudyCell } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { useResource } from '../../utils/useResource';
import type { StudyContent } from '../Project/projectModel';
import { CellBar } from '../Studies/parts';
import { BLOCK_LABELS, describeRun, type Block, type BlockKind } from './reportsModel';

interface BlocksProps {
  blocks: readonly Block[];
  editable: boolean;
  studies: readonly StudyContent[] | undefined;
  org: string;
  project: string;
  onChange: (blocks: Block[]) => void;
}

/** How the cells of a run ended, as the bar of the study screens; nothing when the run's study can't be found. */
function RunBar({ runId, studies, org, project }: { runId: string; studies: readonly StudyContent[] | undefined; org: string; project: string }) {
  const study = (studies ?? []).find(({ runs }) => runs.some((run) => run.id === runId))?.study;
  // The key names the study too: the runs of the project arrive after the report, and a bar read before them must be read again.
  const cells = useResource<StudyCell[]>(`report-run-cells:${study?.slug ?? 'unknown'}:${runId}`, () => (study ? platformApi.studyCells(org, project, study.slug, runId).catch(() => []) : Promise.resolve([])));
  if (!study || !cells.data || cells.data.length === 0) return null;
  return <CellBar cells={cells.data} size="md" legend note={`${cells.data.length} cells`} />;
}

function EvidenceBlock({ block, studies, org, project }: { block: Block; studies: readonly StudyContent[] | undefined; org: string; project: string }) {
  const root = `/app/${org}/${project}`;
  const run = block.runId ? describeRun(block.runId, studies, root) : null;
  return (
    <div className="rp-evidence-block">
      <strong>{block.text || run?.label || 'Evidence'}</strong>
      {block.runId && <RunBar runId={block.runId} studies={studies} org={org} project={project} />}
      {run && (
        <span className="rp-links">
          {run.href ? <Link to={run.href}>Open the run</Link> : <small>The run isn’t listed in this project.</small>}
          {run.analytics && <Link to={run.analytics}>Compare results</Link>}
        </span>
      )}
    </div>
  );
}

/** The content of a report as blocks: read as a page, or edited block by block when the draft is the person's to change. */
export function ReportBlocks({ blocks, editable, studies, org, project, onChange }: BlocksProps) {
  const [picking, setPicking] = useState(false);
  const [run, setRun] = useState('');
  const runs = (studies ?? []).flatMap(({ study, runs: list }) => list.map((item) => ({ id: item.id, label: `${study.name} · run #${item.run_number} · ${item.state}` })));

  const update = (index: number, patch: Partial<Block>) => onChange(blocks.map((block, position) => (position === index ? { ...block, ...patch } : block)));
  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const add = (kind: BlockKind, extra: Partial<Block> = {}) => onChange([...blocks, { kind, text: '', ...extra }]);

  return (
    <div className="rp-blocks">
      {blocks.length === 0 && (
        <div className="rp-empty">{editable ? 'Empty report. Add a heading, some text or a piece of evidence.' : 'This report has no written content yet.'}</div>
      )}
      {blocks.map((block, index) => (
        <section key={index} className={`rp-block is-${block.kind}`} aria-label={`${BLOCK_LABELS[block.kind]} block ${index + 1}`}>
          <header>
            <Chip tone={block.kind === 'evidence' ? 'accent' : 'plain'}>{BLOCK_LABELS[block.kind]}</Chip>
            {editable && (
              <span className="rp-block-tools">
                <button type="button" aria-label="Move block up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} aria-hidden="true" /></button>
                <button type="button" aria-label="Move block down" disabled={index === blocks.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} aria-hidden="true" /></button>
                <button type="button" aria-label="Remove block" className="is-danger" onClick={() => onChange(blocks.filter((_, position) => position !== index))}><X size={14} aria-hidden="true" /></button>
              </span>
            )}
          </header>
          {block.kind === 'evidence' ? (
            <EvidenceBlock block={block} studies={studies} org={org} project={project} />
          ) : editable ? (
            <label>
              <span className="sr-only">{BLOCK_LABELS[block.kind]} text</span>
              <textarea
                value={block.text}
                rows={block.kind === 'heading' ? 1 : 4}
                placeholder={block.kind === 'citation' ? 'Author, title, year, DOI' : block.kind === 'heading' ? 'A heading' : 'Write here'}
                onChange={(event) => update(index, { text: event.target.value })}
              />
            </label>
          ) : block.kind === 'heading' ? (
            <h2 className="rp-heading">{block.text}</h2>
          ) : (
            <p className={block.kind === 'citation' ? 'rp-quote' : undefined}>{block.text}</p>
          )}
        </section>
      ))}

      {editable && (
        <div className="rp-add">
          <Action variant="secondary" size="sm" onClick={() => add('heading')}>+ Heading</Action>
          <Action variant="secondary" size="sm" onClick={() => add('text')}>+ Text</Action>
          <Action variant="secondary" size="sm" onClick={() => setPicking((open) => !open)} aria-expanded={picking}>+ Evidence: study run</Action>
          <Action variant="secondary" size="sm" onClick={() => add('citation')}>+ External citation</Action>
          {picking && (
            <span className="rp-pick">
              <label>
                <span className="sr-only">Study run to cite</span>
                <select value={run} onChange={(event) => setRun(event.target.value)}>
                  <option value="">Choose a study run</option>
                  {runs.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              <Action
                variant="primary"
                size="sm"
                disabled={!run}
                onClick={() => {
                  add('evidence', { runId: run, text: runs.find((item) => item.id === run)?.label ?? '' });
                  setRun('');
                  setPicking(false);
                }}
              >
                Add
              </Action>
              {runs.length === 0 && <small>This project has no study runs yet.</small>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
