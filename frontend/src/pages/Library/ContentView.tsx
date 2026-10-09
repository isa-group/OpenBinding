import type { ReactNode } from 'react';
import { Chip } from '../../components/ui/Chip';
import { shortDigest } from '../../utils/digest';
import { formatBytes } from '../../utils/format';
import {
  brief, catalogOf, isCaseRevisionRef, isObject, isVersionRef, labelOf, rulesOf, sourceOf, summarizeXml,
  type CatalogView, type Content, type Json, type JsonObject, type RuleRow,
} from './contentModel';
import { plural } from './libraryModel';

const MAX_COLUMNS = 8;

const isPrimitive = (value: unknown): value is string | number | boolean | null => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/** A value that fits one table cell: a primitive, a list of primitives or an object of primitives. */
const isBrief = (value: Json): boolean => isPrimitive(value)
  || (Array.isArray(value) && value.every(isPrimitive))
  || (isObject(value) && Object.values(value).every(isPrimitive));

/** An object whose values all fit a cell, so a map of them reads as a table. */
const isFlatRecord = (value: Json): value is JsonObject => isObject(value) && Object.keys(value).length > 0 && Object.values(value).every(isBrief);

function Primitive({ value }: { value: string | number | boolean | null }) {
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (value === null || value === '') return <span className="lib-none">—</span>;
  return <span className="lib-text">{String(value)}</span>;
}

export function RefLine({ value }: { value: { name: string; version: string; versionDigest: string } }) {
  return (
    <span className="lib-ref">
      <strong>{value.name}</strong>
      <Chip tone="accent">v{value.version}</Chip>
      <code title={value.versionDigest}>{shortDigest(value.versionDigest)}</code>
    </span>
  );
}

function RecordTable({ rows, indexLabel, caption }: { rows: Array<[string, JsonObject]>; indexLabel: string; caption: string }) {
  const columns: string[] = [];
  for (const [, record] of rows) for (const key of Object.keys(record)) if (!columns.includes(key) && columns.length < MAX_COLUMNS) columns.push(key);
  return (
    <div className="lib-table-scroll">
      <table className="lib-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{indexLabel}</th>
            {columns.map((column) => <th scope="col" key={column}>{labelOf(column)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, record]) => (
            <tr key={key}>
              <th scope="row"><code>{key}</code></th>
              {columns.map((column) => <td key={column}>{brief(record[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Any JSON value as something a person can read: tables for lists and maps of records, fields for the rest. */
export function ValueView({ value, caption = 'Values' }: { value: Json; caption?: string }) {
  if (isPrimitive(value)) return <Primitive value={value} />;
  if (isVersionRef(value)) return <RefLine value={value} />;
  if (isCaseRevisionRef(value)) return <span className="lib-ref"><strong>Case revision</strong><code title={value.caseRevisionId}>{shortDigest(value.compositionDigest)}</code></span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="lib-none">None</span>;
    if (value.every(isPrimitive)) {
      return <ul className="lib-chips" aria-label={caption}>{value.map((item, index) => <li key={index}><Chip>{String(item)}</Chip></li>)}</ul>;
    }
    if (value.every(isFlatRecord)) return <RecordTable rows={value.map((item, index) => [String(index + 1), item as JsonObject])} indexLabel="#" caption={caption} />;
    return <ol className="lib-stack" aria-label={caption}>{value.map((item, index) => <li key={index}><ValueView value={item} caption={`${caption} ${index + 1}`} /></li>)}</ol>;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="lib-none">None</span>;
  if (entries.every(([, child]) => isFlatRecord(child))) return <RecordTable rows={entries as Array<[string, JsonObject]>} indexLabel="Name" caption={caption} />;
  return (
    <dl className="lib-fields">
      {entries.map(([key, child]) => (
        <div key={key}>
          <dt>{labelOf(key)}{labelOf(key) !== key && <code>{key}</code>}</dt>
          <dd><ValueView value={child} caption={labelOf(key)} /></dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="lib-card" aria-label={title}>
      <header><h3>{title}</h3>{note && <span>{note}</span>}</header>
      {children}
    </section>
  );
}

const number = (value: number | undefined) => (value === undefined ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 6 }));

function CatalogContent({ catalog }: { catalog: CatalogView }) {
  if (catalog.groups.length === 0) return <p className="lib-empty-note">This catalog has no candidates.</p>;
  return (
    <>
      {catalog.groups.map((group) => (
        <Section key={group.capability} title={`Capability · ${group.capability || 'none declared'}`} note={plural(group.rows.length, 'candidate')}>
          <div className="lib-table-scroll">
            <table className="lib-table">
              <caption className="sr-only">Candidates for {group.capability || 'no capability'}</caption>
              <thead>
                <tr>
                  <th scope="col">Candidate</th>
                  <th scope="col">Provider</th>
                  {catalog.columns.map((column) => <th scope="col" key={column}>{column}</th>)}
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row"><code>{row.id}</code></th>
                    <td>{row.provider ? <code>{row.provider}</code> : <span className="lib-none">—</span>}</td>
                    {catalog.columns.map((column) => <td key={column}>{number(row.features[column])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ))}
    </>
  );
}

function RulesContent({ rules }: { rules: RuleRow[] }) {
  if (rules.length === 0) return <p className="lib-empty-note">There are no rules.</p>;
  return (
    <Section title="Rules" note={plural(rules.length, 'rule')}>
      <div className="lib-table-scroll">
        <table className="lib-table">
          <caption className="sr-only">Rules</caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Kind</th>
              <th scope="col">Condition</th>
              <th scope="col">Penalty</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                <th scope="row"><code>{rule.id}</code></th>
                <td><Chip tone={rule.enforcement === 'hard' ? 'accent' : 'plain'}>{rule.enforcement === 'hard' ? 'Must' : 'Should'}</Chip></td>
                <td><code className="lib-expression">{rule.condition || '—'}</code></td>
                <td>{rule.penalty === null ? '—' : number(rule.penalty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** A text or XML file is described, not opened: what it is, how big, and how many tasks a workflow draws. */
export function FileSummary({ kind, text }: { kind: string; text: string }) {
  const xml = summarizeXml(text);
  return (
    <section className="lib-card" aria-label="File">
      <header><h3>{kind === 'BPMN' ? 'Workflow file' : 'File'}</h3>{xml.ok && xml.root && <span>XML · {xml.root}</span>}</header>
      <dl className="lib-glance">
        <div><dt>Size</dt><dd>{formatBytes(xml.bytes) ?? '—'}</dd></div>
        <div><dt>Lines</dt><dd>{xml.lines.toLocaleString('en-US')}</dd></div>
        {kind === 'BPMN' && xml.ok && <div><dt>Tasks</dt><dd>{xml.tasks}</dd></div>}
      </dl>
      {!xml.ok && <p className="lib-error-text">The file is not well-formed XML: {xml.error}</p>}
    </section>
  );
}

export function ViewSource({ content }: { content: Content }) {
  return (
    <details className="lib-source">
      <summary>View source</summary>
      <pre tabIndex={0} aria-label="Source of the content">{sourceOf(content)}</pre>
    </details>
  );
}

/** Everything else: one card per field of the document, so no kind is left without a readable view. */
function GenericContent({ content }: { content: JsonObject }) {
  const body = isObject(content.spec) ? content.spec : content;
  const skipped = isObject(content.spec) ? new Set(['apiVersion', 'kind', 'metadata', 'spec']) : new Set(['apiVersion']);
  const extras = isObject(content.spec) ? Object.entries(content).filter(([key]) => !skipped.has(key)) : [];
  const entries = [...Object.entries(body).filter(([key]) => body !== content || !skipped.has(key)), ...extras];
  if (entries.length === 0) return <p className="lib-empty-note">This content has no fields.</p>;
  return (
    <>
      {entries.map(([key, value]) => (
        <Section key={key} title={labelOf(key)}>
          <ValueView value={value} caption={labelOf(key)} />
        </Section>
      ))}
    </>
  );
}

/** The content of an item, as a reader sees it. The raw source is behind a control, never the main view. */
export function ContentView({ kind, content }: { kind: string; content: Content }) {
  if (typeof content === 'string') {
    return (
      <div className="lib-content">
        <FileSummary kind={kind} text={content} />
        <ViewSource content={content} />
      </div>
    );
  }
  const catalog = kind === 'CandidateCatalog' ? catalogOf(content) : null;
  const rules = kind === 'ConstraintSet' ? rulesOf(content) : null;
  const language = typeof content.apiVersion === 'string' ? content.apiVersion : null;
  return (
    <div className="lib-content">
      {language && <p className="lib-language">Written in <code>{language}</code></p>}
      {catalog ? <CatalogContent catalog={catalog} /> : rules ? <RulesContent rules={rules} /> : <GenericContent content={content} />}
      <ViewSource content={content} />
    </div>
  );
}
