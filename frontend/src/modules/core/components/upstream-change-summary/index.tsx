// Pattern only, after SPHERE frontend/src/modules/pricing/utils/change-summary.ts and
// frontend/src/modules/pricing/components/pricing-version-graph/change-summary-card.tsx (revision 7c7074ff),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// What an upstream event says changed (F6), the plan's `ChangeSummary` for an event: why rebinding is recommended, what
// the composition's global values become, each bound entry's attributes before and after with the target they map to and
// the delta, and the notes; for an offering event, a catalog line after SPHERE's version summary (each section's plans,
// add-ons, features and usage limits added, removed or changed, counted) and each plan's row before and after. Everything is the
// gateway's stored diff (`openbinding/upstream-event-diff@1`) in words: amounts are formatted from their text, and
// nothing is compared, summed or decided here. SPHERE has no upstream events; the sections follow the renderer's.

import type { ReactNode } from 'react';
import type { UpstreamEventDetail } from '../../api/types';
import { DataTable } from '../data-table';
import { decimalText, deltaText, moneyText } from './format';
import { noteText, reasonText, type Reason } from './words';

type Diff = Record<string, unknown>;

interface Attribute {
  target: string;
  targetKind?: string;
  sourceKind?: string;
  before: string | null;
  after: string | null;
  delta: string | null;
}

interface Requirement {
  name: string;
  kind: 'feature' | 'limit' | string;
  demand?: string | null;
  before: boolean;
  after: boolean;
  valueBefore?: string | null;
  valueAfter?: string | null;
}

/** A value as the plan comparison writes it (`toComparedValue`): its kind and, for most kinds, the value. */
interface ComparedValue {
  kind: 'none' | 'boolean' | 'number' | 'unlimited' | 'text' | 'json' | string;
  value?: unknown;
}

/** A feature or usage limit of the bound plan, compared. */
interface ComparedItem {
  id: string;
  name?: string | null;
  before: ComparedValue;
  after: ComparedValue;
}

interface Entry {
  task: string;
  candidate: string;
  selection?: { plan?: string; addOns?: string[]; billing?: string | null; seats?: number | null };
  comparison?: {
    features?: { gained?: ComparedItem[]; lost?: ComparedItem[]; changed?: ComparedItem[] };
    usageLimits?: ComparedItem[];
    plan?: { renamedTo?: string | null };
  } | null;
  attributes?: Attribute[];
  requirements?: Requirement[];
  reasons?: Reason[];
  originMismatch?: Array<{ target: string; stored: string | null; recomputed: string | null }>;
}

interface GlobalLine {
  feature: string;
  unit?: string | null;
  before: string | null;
  after: string | null;
  delta: string | null;
}

/** A plan's feature or limit value in an offering diff: a boolean, a number's text, text, or `{unlimited: true}`. */
type PlanValue = boolean | string | number | null | { unlimited: true } | Record<string, unknown>;

interface PlanSide {
  price?: string | null;
  unit?: string | null;
  features?: Record<string, PlanValue>;
  usageLimits?: Record<string, PlanValue>;
}

interface PlanRow {
  plan: string;
  addOns: string[];
  changed: boolean;
  before: PlanSide | null;
  after: PlanSide | null;
}

interface Catalog {
  plans?: { added?: string[]; removed?: string[] };
  addOns?: { added?: string[]; removed?: string[] };
  features?: { added?: string[]; removed?: string[] };
  usageLimits?: { added?: string[]; removed?: string[] };
}

const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const SOURCE_WORDS: Record<string, string> = {
  priced: 'Price',
  guarantee: 'Guarantee',
  limit: 'Usage limit',
  feature: 'Feature',
};

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="m-0 text-[13px] font-semibold text-tp-ink">{children}</h3>;
}

/** "subscription 508.99 → 558.99 USD/month, +50.00". */
function globalLineText(line: GlobalLine): string {
  const money = Boolean(line.unit && /\//.test(line.unit));
  const show = (value: string | null) =>
    value === null ? 'unknown' : money ? moneyText(value) : decimalText(value);
  const unit = line.unit ? ` ${line.unit}` : '';
  const delta = line.delta !== null ? `, ${deltaText(line.delta, money)}` : '';
  return `${line.feature} ${show(line.before)} → ${show(line.after)}${unit}${delta}`;
}

function valueText(value: string | null | undefined, money: boolean): string {
  if (value === null || value === undefined) return '—';
  return money ? moneyText(value) : decimalText(value);
}

/** A compared value in words: "Unlimited", "150,000", "yes", the text; "—" when the plan does not declare it. */
function comparedText(value: ComparedValue | null | undefined): string {
  if (!value || value.kind === 'none') return '—';
  if (value.kind === 'unlimited') return 'Unlimited';
  if (value.kind === 'boolean') return value.value ? 'yes' : 'no';
  if (value.kind === 'number' && typeof value.value === 'string') return decimalText(value.value);
  if (typeof value.value === 'string') return value.value;
  return JSON.stringify(value.value ?? null);
}

/** An offering plan's value in words, the same way. */
function planValueText(value: PlanValue | undefined): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return decimalText(String(value));
  if (typeof value === 'string') return decimalText(value);
  if ('unlimited' in value && value.unlimited === true) return 'Unlimited';
  return JSON.stringify(value);
}

const itemName = (item: ComparedItem) => item.name || item.id;

function selectionText(entry: Entry): string {
  const selection = entry.selection;
  if (!selection?.plan) return entry.candidate;
  const addOns = selection.addOns?.length ? ` with ${selection.addOns.join(', ')}` : '';
  const billing = selection.billing ? `, billed ${selection.billing}` : '';
  return `plan ${selection.plan}${addOns}${billing}`;
}

function EntryView({ entry }: { entry: Entry }) {
  const attributes = entry.attributes ?? [];
  const features = entry.comparison?.features;
  const limits = (entry.comparison?.usageLimits ?? []).filter(
    limit => comparedText(limit.before) !== comparedText(limit.after)
  );
  const requirements = (entry.requirements ?? []).filter(
    requirement => !requirement.after || requirement.valueBefore !== requirement.valueAfter
  );
  const featureLines = [
    ...(features?.gained ?? []).map(item => `${itemName(item)} is now included`),
    ...(features?.lost ?? []).map(item => `${itemName(item)} is no longer included`),
    ...(features?.changed ?? []).map(
      item => `${itemName(item)}: ${comparedText(item.before)} → ${comparedText(item.after)}`
    ),
  ];
  return (
    <section
      aria-label={`${entry.task}: ${entry.candidate}`}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-tp-hairline p-3"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <Heading>{entry.task}</Heading>
        <code className="font-mono text-xs break-all text-tp-slate">{entry.candidate}</code>
        <span className="text-xs text-tp-steel">{selectionText(entry)}</span>
      </div>
      {attributes.length > 0 ? (
        <DataTable label={`What ${entry.task} reads from the pricing`} minWidth={480}>
          <thead>
            <tr>
              <th scope="col">Read from</th>
              <th scope="col" className="text-right">
                Before
              </th>
              <th scope="col" className="text-right">
                After
              </th>
              <th scope="col">Maps to</th>
              <th scope="col" className="text-right">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {attributes.map(attribute => {
              const money = attribute.sourceKind === 'priced';
              const same = attribute.before === attribute.after;
              return (
                <tr key={`${attribute.target}-${attribute.sourceKind ?? ''}`}>
                  <td>{SOURCE_WORDS[attribute.sourceKind ?? ''] ?? attribute.sourceKind ?? '—'}</td>
                  <td className="text-right font-mono tabular-nums" title={attribute.before ?? ''}>
                    {valueText(attribute.before, money)}
                  </td>
                  <td
                    className={`text-right font-mono tabular-nums ${same ? '' : 'font-semibold'}`}
                    title={attribute.after ?? ''}
                  >
                    {valueText(attribute.after, money)}
                  </td>
                  <td>
                    <code className="font-mono text-xs">{attribute.target}</code>
                    {attribute.targetKind && (
                      <span className="ml-1 text-[11px] text-tp-steel">{attribute.targetKind}</span>
                    )}
                  </td>
                  <td className="text-right font-mono tabular-nums">
                    {attribute.delta !== null
                      ? deltaText(attribute.delta, money)
                      : same
                        ? 'unchanged'
                        : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      ) : (
        <p className="m-0 text-xs text-tp-steel">
          No value of this entry was read from the pricing by OpenBinding, so only the plan and its
          add-ons were checked.
        </p>
      )}
      {(featureLines.length > 0 || limits.length > 0) && (
        <ul className="m-0 list-disc pl-5 text-xs text-tp-slate">
          {featureLines.map(line => (
            <li key={line}>{line}</li>
          ))}
          {limits.map(limit => (
            <li key={`limit-${limit.id}`}>
              {`${itemName(limit)}: ${comparedText(limit.before)} → ${comparedText(limit.after)}`}
            </li>
          ))}
        </ul>
      )}
      {requirements.length > 0 && (
        <ul aria-label="Requirements" className="m-0 list-disc pl-5 text-xs text-tp-slate">
          {requirements.map(requirement => (
            <li key={`${requirement.kind}-${requirement.name}`}>
              {requirement.kind === 'feature'
                ? `Requires ${requirement.name}: ${requirement.after ? 'still included' : 'no longer included'}`
                : `Requires ${requirement.name} ≥ ${valueText(requirement.demand, false)}: ${valueText(requirement.valueBefore, false)} → ${valueText(requirement.valueAfter, false)}${requirement.after ? '' : ', no longer met'}`}
            </li>
          ))}
        </ul>
      )}
      {(entry.originMismatch ?? []).map(mismatch => (
        <p key={mismatch.target} className="m-0 text-xs text-tp-steel">
          {`${mismatch.target}: the value stored when this version was made (${valueText(mismatch.stored, false)}) differs from today’s reading of the same pricing version (${valueText(mismatch.recomputed, false)}). That is a change in how OpenBinding reads pricings, not an upstream change.`}
        </p>
      ))}
    </section>
  );
}

const count = (items: string[] | undefined, one: string, many: string, what: string) =>
  items && items.length > 0 ? `${items.length} ${items.length === 1 ? one : many} ${what}` : null;

/** SPHERE's catalog line for an offering event: "1 plan changed · 1 add-on added". */
function catalogLine(catalog: Catalog | null, rows: PlanRow[]): string {
  const changedPlans = new Set(
    rows.filter(row => row.changed && row.addOns.length === 0).map(row => row.plan)
  );
  const changedVariants = rows.filter(row => row.changed && row.addOns.length > 0).length;
  const parts = [
    changedPlans.size > 0
      ? `${changedPlans.size} ${changedPlans.size === 1 ? 'plan' : 'plans'} changed`
      : null,
    changedVariants > 0
      ? `${changedVariants} ${changedVariants === 1 ? 'plan with an add-on' : 'plans with an add-on'} changed`
      : null,
    count(catalog?.plans?.added, 'plan', 'plans', 'added'),
    count(catalog?.plans?.removed, 'plan', 'plans', 'removed'),
    count(catalog?.addOns?.added, 'add-on', 'add-ons', 'added'),
    count(catalog?.addOns?.removed, 'add-on', 'add-ons', 'removed'),
    count(catalog?.features?.added, 'feature', 'features', 'added'),
    count(catalog?.features?.removed, 'feature', 'features', 'removed'),
    count(catalog?.usageLimits?.added, 'usage limit', 'usage limits', 'added'),
    count(catalog?.usageLimits?.removed, 'usage limit', 'usage limits', 'removed'),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'No plan’s values changed';
}

/** What a plan row gained or lost between the two offering versions, in words. */
function planChanges(row: PlanRow): string {
  const before = row.before;
  const after = row.after;
  if (!before) return 'New';
  if (!after) return 'No longer offered';
  const parts: string[] = [];
  for (const [name, value] of Object.entries(after.features ?? {})) {
    const was = (before.features ?? {})[name];
    if (planValueText(was) === planValueText(value)) continue;
    if (typeof value === 'boolean' && (typeof was === 'boolean' || was === undefined))
      parts.push(value ? `gains ${name}` : `loses ${name}`);
    else parts.push(`${name} ${planValueText(was)} → ${planValueText(value)}`);
  }
  for (const [name, value] of Object.entries(after.usageLimits ?? {})) {
    const was = (before.usageLimits ?? {})[name];
    if (planValueText(was) !== planValueText(value))
      parts.push(`${name} ${planValueText(was)} → ${planValueText(value)}`);
  }
  return parts.length > 0 ? parts.join('; ') : row.changed ? 'Price only' : 'Unchanged';
}

function OfferingRows({ rows }: { rows: PlanRow[] }) {
  return (
    <DataTable label="Offering plans before and after" minWidth={560}>
      <thead>
        <tr>
          <th scope="col">Plan</th>
          <th scope="col">Add-on</th>
          <th scope="col" className="text-right">
            Price before
          </th>
          <th scope="col" className="text-right">
            Price after
          </th>
          <th scope="col">What changed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr
            key={`${row.plan}+${row.addOns.join('+')}`}
            className={row.changed ? '' : 'text-tp-steel'}
          >
            <td className="font-medium">{row.plan}</td>
            <td>{row.addOns.length ? row.addOns.join(', ') : '—'}</td>
            <td className="text-right font-mono tabular-nums">
              {valueText(row.before?.price, true)}
              {row.before?.unit && (
                <span className="ml-1 font-sans text-[11px]">{row.before.unit}</span>
              )}
            </td>
            <td
              className={`text-right font-mono tabular-nums ${row.changed ? 'font-semibold' : ''}`}
            >
              {valueText(row.after?.price, true)}
              {row.after?.unit && (
                <span className="ml-1 font-sans text-[11px]">{row.after.unit}</span>
              )}
            </td>
            <td className="text-xs">{planChanges(row)}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

interface Props {
  event: Pick<UpstreamEventDetail, 'category' | 'subject' | 'reasons' | 'pricing' | 'diff'>;
}

/** The change an upstream event recorded, in words; it draws the gateway's diff and decides nothing. */
export function UpstreamChangeSummary({ event }: Props) {
  const diff = (event.diff ?? {}) as Diff;
  const reasons = event.reasons as unknown as Reason[];
  const entries = list<Entry>(diff.entries);
  const globals = list<GlobalLine>(diff.global);
  const notes = list<string>(diff.notes);
  const offering = event.subject === 'offering';
  const rows = list<PlanRow>(diff.plans);
  const host = text(event.pricing.url) ? safeHost(event.pricing.url as string) : null;
  return (
    <div className="flex min-w-0 flex-col gap-4" aria-label="What changed">
      {reasons.length > 0 && (
        <section aria-label="Why" className="flex flex-col gap-1.5">
          <Heading>
            {event.category === 'binding_invalid'
              ? 'Why rebinding is recommended'
              : 'What happened'}
          </Heading>
          <ul className="m-0 list-disc pl-5 text-sm text-tp-ink">
            {reasons.map((reason, index) => (
              <li key={`${reason.code}-${index}`}>{reasonText(reason, host)}</li>
            ))}
          </ul>
        </section>
      )}
      {!offering && globals.length > 0 && (
        <section aria-label="Global values" className="flex flex-col gap-1.5">
          <Heading>What the composition’s values would become</Heading>
          <ul className="m-0 list-none p-0 text-sm text-tp-ink">
            {globals.map(line => (
              <li key={line.feature} className="font-mono text-[13px]">
                {globalLineText(line)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!offering && entries.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2">
          {entries.map(entry => (
            <EntryView key={`${entry.task}-${entry.candidate}`} entry={entry} />
          ))}
        </div>
      )}
      {offering && (
        <section aria-label="Offering plans" className="flex min-w-0 flex-col gap-2">
          <Heading>{catalogLine((diff.catalog ?? null) as Catalog | null, rows)}</Heading>
          {rows.length > 0 && <OfferingRows rows={rows} />}
        </section>
      )}
      {notes.length > 0 && (
        <ul
          aria-label="Notes"
          className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-tp-steel"
        >
          {notes.map(note => (
            <li key={note}>{noteText(note)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
