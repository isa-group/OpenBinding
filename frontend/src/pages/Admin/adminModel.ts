import { PricingUnavailableError, QuotaError } from '../../api/auth';
import type { AdminAuditPage, PricingCatalog } from '../../api/auth';
import { HttpError } from '../../api/client';
import { diagnosticsOf } from '../../api/problem';
import { formatDate } from '../../utils/format';
import { describeLimit, LIMIT_ORDER, limitInfo, type LimitText } from '../../utils/limits';
import type { ApiErrorEventItem } from './types';

/** What the administration screens share: wording of failures, the pricing catalog read for contracts, and audit and error events in words. */

// -- The administration sections ---------------------------------------------------------------

export const ADMIN_SECTIONS = [
  { id: 'overview', label: 'Overview', to: '/app/admin' },
  { id: 'users', label: 'Accounts', to: '/app/admin/users' },
  { id: 'audit', label: 'Audit', to: '/app/admin/audit' },
  { id: 'errors', label: 'Errors', to: '/app/admin/errors' },
  { id: 'queues', label: 'Queues', to: '/app/admin/queues' },
  { id: 'moderation', label: 'Moderation', to: '/app/admin/moderation' },
  { id: 'maintenance', label: 'Maintenance', to: '/app/admin/maintenance' },
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number]['id'];

// -- Failures ---------------------------------------------------------------------------------------

export interface Failure {
  /** The HTTP status, when the gateway answered. */
  status: number | null;
  code: string | null;
  title: string;
  text: string;
  tone: 'error' | 'warning';
  /** The quota the gateway named on a 402. */
  quota: QuotaError['quota'] | null;
}

function codeOf(error: unknown): string | null {
  if (error instanceof QuotaError) return error.code;
  if (error instanceof PricingUnavailableError) return 'pricing_unavailable';
  if (error instanceof HttpError) return error.code ?? null;
  return null;
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return '';
  // `HttpError` words its message as “HTTP 409: …”; the reason is what follows.
  return error.message.replace(/^HTTP \d+:\s*/, '').trim();
}

/**
 * Turn whatever a request threw into a headline and a sentence. `what` is the thing that was being done
 * (“The accounts couldn’t be loaded”); the status decides what else is worth saying.
 */
export function describeAdminFailure(error: unknown, what: string): Failure {
  const reason = messageOf(error);
  const code = codeOf(error);
  const status = error instanceof QuotaError ? 402 : error instanceof PricingUnavailableError ? 503 : error instanceof HttpError ? error.status : null;
  const quota = error instanceof QuotaError ? error.quota ?? null : null;
  const withCode = (title: string) => (code ? `${title} (${status} · ${code})` : status ? `${title} (${status})` : title);
  switch (status) {
    case 401:
      return { status, code, tone: 'error', quota, title: 'Your session ended', text: 'Log in again to continue. Nothing was changed.' };
    case 403:
      return {
        status, code, tone: 'error', quota,
        title: 'This key can’t use administration (403)',
        text: 'The account is an administrator, but the API key behind this session doesn’t include the administration permission this needs (admin:accounts:read or admin:accounts:write).',
      };
    case 404:
      return { status, code, tone: 'error', quota, title: withCode('Not found'), text: reason || 'The gateway has nothing with that identifier.' };
    case 402:
      return { status, code, tone: 'error', quota, title: withCode('Over a limit'), text: reason || 'A limit would be passed.' };
    case 409:
      return { status, code, tone: 'error', quota, title: withCode('The gateway refused the change'), text: reason || 'The change conflicts with the current state.' };
    case 422: {
      // The problem's `detail` is one summary sentence; its diagnostics say which fields (pointers into the document) are wrong.
      const findings = diagnosticsOf(error).map((diagnostic) => (diagnostic.pointer ? `${diagnostic.pointer}: ${diagnostic.message}` : diagnostic.message));
      const text = [reason, ...findings.filter((finding) => !reason.includes(finding))].filter(Boolean).slice(0, 4).join(' ');
      return { status, code, tone: 'error', quota, title: withCode('That isn’t valid'), text: text || 'The gateway refused the value.' };
    }
    case 503:
      return {
        status, code, tone: 'warning', quota,
        title: withCode('A service isn’t available right now'),
        text: `${reason ? `${reason} ` : ''}Nothing was changed. Try again in a moment.`.trim(),
      };
    default:
      return { status, code, tone: 'error', quota, title: what, text: reason || 'Try again; if it keeps failing, check the gateway.' };
  }
}

/**
 * A failure of moderation. A key needs the moderation permission for what it decides, not the accounts one, and a 409 here
 * usually means somebody else decided first.
 */
export function describeModerationFailure(error: unknown, what: string, scope: 'engines' | 'extensions'): Failure {
  const base = describeAdminFailure(error, what);
  if (base.status === 403) {
    const [label, permission] = scope === 'engines' ? ['moderate engines', 'engines:moderate'] : ['moderate extensions', 'extensions:moderate'];
    return {
      ...base,
      title: 'This key can’t moderate (403)',
      text: `The account is an administrator, but the API key behind this session doesn’t include “${label}” (${permission}).`,
    };
  }
  if (base.status === 409) {
    return {
      ...base,
      title: base.code ? `This can’t be decided now (409 · ${base.code})` : 'This can’t be decided now (409)',
      text: `${base.text} Another administrator may have decided it first; refresh to see its current state.`,
    };
  }
  return base;
}

// -- Small formatters ----------------------------------------------------------------------------------

/** `3f2a91c0…`: enough of an identifier to tell two apart in a list. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** “12 min”, “about 3 h”, “about 2 days”: how long ago something happened, to the nearest sensible unit. */
export function ageLabel(from: string | null | undefined, now: number): string {
  const started = from ? new Date(from).getTime() : NaN;
  if (Number.isNaN(started)) return '—';
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `about ${Math.round(seconds / 3600)} h`;
  const days = Math.round(seconds / 86400);
  return `about ${days} ${days === 1 ? 'day' : 'days'}`;
}

export function ageSeconds(from: string | null | undefined, now: number): number | null {
  const started = from ? new Date(from).getTime() : NaN;
  return Number.isNaN(started) ? null : Math.max(0, Math.round((now - started) / 1000));
}

export function count(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : '—';
}

export type ChipTone = 'plain' | 'info' | 'success' | 'warning' | 'error' | 'dark';

export function planTone(plan: string): ChipTone {
  switch (plan) {
    case 'PRO': return 'dark';
    case 'ADVANCED': case 'RESEARCH': return 'info';
    default: return 'plain';
  }
}

// -- The pricing catalog, read for contracts -------------------------------------------------------------------

export interface ContractPlan {
  id: string;
  description: string;
  byAgreement: boolean;
  /** Per limit: the figure, `null` for “no limit”. */
  limits: Record<string, number | null>;
}

export interface ContractAddOn {
  id: string;
  name: string;
  description: string;
  plans: string[];
  unit: string;
  min: number;
  max: number;
  step: number;
  /** What one unit adds to each limit. */
  extensions: Record<string, number>;
  dependsOn: string[];
  excludes: string[];
}

export interface ContractCatalog {
  version: string;
  plans: ContractPlan[];
  addOns: ContractAddOn[];
  /** The limits the document defines, in the order the interface lists them. */
  limitIds: string[];
  limitDefinitions: Record<string, Record<string, unknown>>;
}

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value);
const dictOf = (value: unknown): Dict => (isDict(value) ? value : {});
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const textsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/** `expiredApiKeys` and `STORAGE_PACK` as a sentence: “Expired api keys”, “Storage pack”. */
export function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The plans, add-ons and limits of the pricing the gateway serves, or `null` when the document has no plans. */
export function readContractCatalog(catalog: PricingCatalog): ContractCatalog | null {
  const plans = dictOf(catalog.plans);
  const planIds = Object.keys(plans);
  if (planIds.length === 0) return null;
  const definitions = dictOf(catalog.usageLimits);
  const known = [...LIMIT_ORDER.filter((id) => id in definitions), ...Object.keys(definitions).filter((id) => !LIMIT_ORDER.includes(id))];
  const valueOf = (planId: string, limitId: string): number | null => {
    const own = dictOf(dictOf(dictOf(plans[planId]).usageLimits)[limitId]);
    const raw = 'value' in own ? own.value : dictOf(definitions[limitId]).defaultValue;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  };
  return {
    version: textOf(catalog.version),
    plans: planIds.map((id) => {
      const plan = dictOf(plans[id]);
      const price = plan.price;
      const byAgreement = typeof price === 'number' ? price > 0 : typeof price === 'string' && /^contact us/i.test(price);
      return {
        id,
        description: textOf(plan.description).replace(/^Contact us \/ Institutional agreement\.?\s*/i, '').replace(/\.$/, ''),
        byAgreement,
        limits: Object.fromEntries(known.map((limitId) => [limitId, valueOf(id, limitId)])),
      };
    }),
    addOns: Object.entries(dictOf(catalog.addOns)).map(([id, value]) => {
      const addOn = dictOf(value);
      const constraints = dictOf(addOn.subscriptionConstraints);
      const num = (field: string, fallback: number) => (typeof constraints[field] === 'number' ? constraints[field] as number : fallback);
      const extensions = Object.fromEntries(Object.entries(dictOf(addOn.usageLimitsExtensions))
        .flatMap(([limitId, extension]) => {
          const amount = dictOf(extension).value;
          return typeof amount === 'number' ? [[limitId, amount] as const] : [];
        }));
      return {
        id,
        name: humanize(id),
        description: textOf(addOn.description).replace(/\.$/, ''),
        plans: textsOf(addOn.availableFor),
        unit: textOf(addOn.unit),
        min: num('minQuantity', 1),
        max: num('maxQuantity', 1),
        step: num('quantityStep', 1),
        extensions,
        dependsOn: textsOf(addOn.dependsOn),
        excludes: textsOf(addOn.excludes),
      };
    }),
    limitIds: known,
    limitDefinitions: Object.fromEntries(known.map((limitId) => [limitId, dictOf(definitions[limitId])])),
  };
}

/** What a plan with these add-ons allows, limit by limit; `null` is “no limit”. */
export function limitsOf(catalog: ContractCatalog, planId: string, addOns: Record<string, number>): Record<string, number | null> {
  const plan = catalog.plans.find((item) => item.id === planId);
  const result: Record<string, number | null> = {};
  for (const limitId of catalog.limitIds) {
    let value = plan?.limits[limitId] ?? null;
    for (const [addOnId, quantity] of Object.entries(addOns)) {
      const extension = catalog.addOns.find((item) => item.id === addOnId)?.extensions[limitId];
      if (value !== null && extension !== undefined && quantity > 0) value += extension * quantity;
    }
    result[limitId] = value;
  }
  return result;
}

/** Why an agreement can’t be applied, before asking the gateway. Empty when it can. */
export function agreementIssues(catalog: ContractCatalog, planId: string, addOns: Record<string, number>): string[] {
  if (!catalog.plans.some((plan) => plan.id === planId)) return ['Choose a plan from the active pricing.'];
  const selected = Object.fromEntries(Object.entries(addOns).filter(([, quantity]) => quantity > 0));
  const issues: string[] = [];
  for (const [id, quantity] of Object.entries(selected)) {
    const addOn = catalog.addOns.find((item) => item.id === id);
    if (!addOn || !addOn.plans.includes(planId)) {
      issues.push(`${addOn?.name ?? id} isn’t available for ${planId}.`);
      continue;
    }
    if (!Number.isInteger(quantity) || quantity < addOn.min || quantity > addOn.max || (quantity - addOn.min) % addOn.step !== 0) {
      issues.push(`${addOn.name} must be ${addOn.min}–${addOn.max} in steps of ${addOn.step}.`);
    }
    for (const dependency of addOn.dependsOn) {
      if (!selected[dependency]) issues.push(`${addOn.name} depends on ${catalog.addOns.find((item) => item.id === dependency)?.name ?? dependency}.`);
    }
    for (const excluded of addOn.excludes) {
      if (selected[excluded]) issues.push(`${addOn.name} excludes ${catalog.addOns.find((item) => item.id === excluded)?.name ?? excluded}.`);
    }
  }
  return [...new Set(issues)];
}

export interface LimitComparison {
  id: string;
  label: string;
  before: LimitText;
  after: LimitText;
  direction: 'up' | 'down' | 'same';
}

const rank = (value: number | null) => (value === null ? Number.POSITIVE_INFINITY : value);

/** Every limit of the pricing, before and after an agreement. */
export function compareLimits(catalog: ContractCatalog, before: Record<string, number | null>, after: Record<string, number | null>): LimitComparison[] {
  return catalog.limitIds.map((id) => {
    const info = limitInfo(id, catalog.limitDefinitions[id]);
    const was = before[id] ?? null;
    const will = after[id] ?? null;
    return {
      id,
      label: info.label,
      before: describeLimit(info.kind, was),
      after: describeLimit(info.kind, will),
      direction: rank(will) > rank(was) ? 'up' : rank(will) < rank(was) ? 'down' : 'same',
    };
  });
}

/** The ceilings of a request are not consumed, so they get no progress bar. */
export function isCeiling(limitId: string, definition?: Dict): boolean {
  const info = limitInfo(limitId, definition);
  return info.group === 'ceiling';
}

// -- Audit events -------------------------------------------------------------------------------------------

export type AuditEvent = AdminAuditPage['events'][number];
export type AuditFamily = 'contract' | 'pricing' | 'maintenance' | 'account' | 'organization' | 'other';

export const AUDIT_FAMILIES: ReadonlyArray<{ id: AuditFamily | ''; label: string }> = [
  { id: '', label: 'All' },
  { id: 'contract', label: 'Contracts' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'account', label: 'Accounts' },
  { id: 'organization', label: 'Organizations' },
  { id: 'other', label: 'Other' },
];

export function auditFamily(action: string): AuditFamily {
  if (action.startsWith('contract.')) return 'contract';
  if (action.startsWith('pricing.')) return 'pricing';
  if (action.startsWith('maintenance.')) return 'maintenance';
  if (action.startsWith('admin.') || action.startsWith('account.')) return 'account';
  if (action.startsWith('organization.')) return 'organization';
  return 'other';
}

interface PlanState {
  plan?: string;
  addOns?: Record<string, number>;
}

const planStateOf = (value: unknown): PlanState => {
  const entry = dictOf(value);
  const addOns = Object.fromEntries(Object.entries(dictOf(entry.addOns)).filter(([, quantity]) => typeof quantity === 'number')) as Record<string, number>;
  return { plan: typeof entry.plan === 'string' ? entry.plan : undefined, addOns };
};

function addOnsText(addOns: Record<string, number> | undefined): string {
  const entries = Object.entries(addOns ?? {}).filter(([, quantity]) => quantity > 0);
  return entries.length ? entries.map(([id, quantity]) => `${humanize(id).toLowerCase()} ×${quantity}`).join(', ') : 'no add-ons';
}

export interface AuditView {
  /** One sentence for the timeline. */
  text: string;
  before: string | null;
  after: string | null;
  /** Short facts read from the event’s detail. */
  facts: Array<[string, string]>;
}

/** An event in words. The detail is whatever the gateway wrote, so every field is read defensively. */
export function describeAuditEvent(event: AuditEvent): AuditView {
  const detail = dictOf(event.detail);
  switch (event.action) {
    case 'contract.subscription.changed': {
      const previous = planStateOf(detail.previous);
      const current = planStateOf(detail.current);
      const reason = textOf(detail.reason);
      const note = textOf(detail.detail);
      const facts: Array<[string, string]> = [];
      if (reason) facts.push(['Reason', humanize(reason)]);
      if (note) facts.push(['Detail', note]);
      if (textOf(detail.pricingVersion)) facts.push(['Pricing version', textOf(detail.pricingVersion)]);
      return {
        text: `Agreement changed from ${previous.plan ?? 'an earlier plan'} to ${current.plan ?? 'a new plan'} (${addOnsText(current.addOns)}).`,
        before: previous.plan ? `${previous.plan} · ${addOnsText(previous.addOns)}` : null,
        after: current.plan ? `${current.plan} · ${addOnsText(current.addOns)}` : null,
        facts,
      };
    }
    case 'maintenance.jobs.reconciled': {
      const settled = typeof detail.settled === 'number' ? detail.settled : null;
      return {
        text: settled === null ? 'Abandoned jobs were reconciled.' : `${settled} abandoned ${settled === 1 ? 'job was' : 'jobs were'} reconciled.`,
        before: null, after: null, facts: settled === null ? [] : [['Settled', String(settled)]],
      };
    }
    case 'maintenance.expired.purged': {
      const facts = (['expiredArtifacts', 'expiredApiKeys', 'terminalJobs', 'abandonedJobs', 'artifactFilesRemoved'] as const)
        .filter((field) => typeof detail[field] === 'number')
        .map((field): [string, string] => [humanize(field), String(detail[field])]);
      return { text: 'Expired data was purged.', before: null, after: null, facts };
    }
    case 'admin.user.updated': {
      const changes = dictOf(detail.changes);
      const facts: Array<[string, string]> = [];
      const parts: string[] = [];
      for (const [field, label] of [['role', 'Role'], ['is_active', 'Status']] as const) {
        const change = dictOf(changes[field]);
        if (change.from === undefined && change.to === undefined) continue;
        const word = (value: unknown) => (field === 'is_active' ? (value === true ? 'active' : 'inactive') : String(value));
        parts.push(`${label.toLowerCase()} ${word(change.from)} → ${word(change.to)}`);
        facts.push([label, `${word(change.from)} → ${word(change.to)}`]);
      }
      const who = textOf(detail.username);
      return { text: `${who ? `Account ${who}` : 'An account'} was updated${parts.length ? `: ${parts.join('; ')}` : ''}.`, before: null, after: null, facts };
    }
    case 'admin.api_key.revoked': {
      const key = dictOf(detail.key);
      const name = textOf(key.name);
      const prefix = textOf(key.prefix);
      const facts: Array<[string, string]> = [];
      if (name) facts.push(['Key name', name]);
      if (prefix) facts.push(['Key prefix', prefix]);
      if (textOf(key.id)) facts.push(['Key id', textOf(key.id)]);
      if (textOf(detail.user_id)) facts.push(['Account', shortId(textOf(detail.user_id))]);
      return { text: `API key${name ? ` “${name}”` : ''}${prefix ? ` (${prefix}…)` : ''} was revoked.`, before: null, after: null, facts };
    }
    case 'admin.usage.resynced': {
      const before = dictOf(detail.before).concurrent_jobs_recorded;
      const after = dictOf(detail.after).concurrent_jobs_recorded;
      const corrected = typeof detail.corrected_by === 'number' ? detail.corrected_by : null;
      const who = textOf(detail.username);
      const facts: Array<[string, string]> = [];
      if (textOf(detail.plan)) facts.push(['Plan', textOf(detail.plan)]);
      if (typeof before === 'number' && typeof after === 'number') facts.push(['Slots recorded', `${before} → ${after}`]);
      if (typeof detail.slots_in_flight === 'number') facts.push(['Jobs in flight', String(detail.slots_in_flight)]);
      return {
        text: `Running-job slots${who ? ` of ${who}` : ''} were recounted${corrected === null ? '' : corrected === 0 ? ' (no drift)' : ` (corrected by ${corrected})`}.`,
        before: null, after: null, facts,
      };
    }
    case 'account.cas.linked': {
      const change = dictOf(detail.plan_changed);
      const from = textOf(change.from);
      const to = textOf(change.to);
      const facts: Array<[string, string]> = [];
      if (textOf(detail.provider)) facts.push(['Provider', textOf(detail.provider)]);
      if (from && to) facts.push(['Plan', `${from} → ${to}${change.extra_cost === false ? ' · no extra cost' : ''}`]);
      return {
        text: from && to ? `An institutional identity was linked and the plan went from ${from} to ${to} at no extra cost.` : 'An institutional identity was linked.',
        before: from || null, after: to || null, facts,
      };
    }
    case 'organization.sponsor_transferred':
    case 'organization.updated': {
      const previous = textOf(detail.previous_sponsor_user_id);
      const next = textOf(detail.new_sponsor_user_id);
      const facts: Array<[string, string]> = [];
      if (previous) facts.push(['Previous sponsor', shortId(previous)]);
      if (next) facts.push(['New sponsor', shortId(next)]);
      return {
        text: event.action === 'organization.sponsor_transferred' || next ? 'The organization’s billing sponsor was changed.' : 'The organization’s settings were updated.',
        before: null, after: null, facts,
      };
    }
    default: {
      if (event.action.startsWith('organization.sponsor.')) {
        const step = event.action.slice('organization.sponsor.'.length);
        const phrase: Record<string, string> = {
          proposed: 'A request to become the billing sponsor was sent',
          accepted: 'A request to become the billing sponsor was accepted',
          declined: 'A request to become the billing sponsor was declined',
          cancelled: 'A request to become the billing sponsor was cancelled',
          expired: 'A request to become the billing sponsor expired',
        };
        const facts: Array<[string, string]> = [];
        if (textOf(detail.proposed_user_id)) facts.push(['Asked to sponsor', shortId(textOf(detail.proposed_user_id))]);
        if (textOf(detail.proposed_by_user_id)) facts.push(['Sent by', shortId(textOf(detail.proposed_by_user_id))]);
        if (textOf(detail.expires_at)) facts.push(['Expires', formatDate(textOf(detail.expires_at)) ?? textOf(detail.expires_at)]);
        if (textOf(detail.previous_sponsor_user_id)) facts.push(['Previous sponsor', shortId(textOf(detail.previous_sponsor_user_id))]);
        if (textOf(detail.new_sponsor_user_id)) facts.push(['New sponsor', shortId(textOf(detail.new_sponsor_user_id))]);
        if (textOf(detail.reason)) facts.push(['Reason', humanize(textOf(detail.reason))]);
        return { text: `${phrase[step] ?? humanize(event.action.replace(/\./g, ' '))}.`, before: null, after: null, facts };
      }
      if (event.action.startsWith('pricing.')) {
        const version = textOf(detail.version) || textOf(detail.pricingVersion) || (event.targetId ?? '');
        const verb = event.action.slice('pricing.'.length).replace(/[._]/g, ' ');
        return {
          text: version ? `Pricing ${verb}: ${version}.` : `Pricing ${verb}.`,
          before: null, after: null,
          facts: version ? [['Version', version]] : [],
        };
      }
      return { text: humanize(event.action.replace(/\./g, ' ')) + '.', before: null, after: null, facts: [] };
    }
  }
}

// -- Error events ----------------------------------------------------------------------------------------------

export interface ErrorRow {
  id: string;
  status: number;
  category: string;
  code: string;
  endpoint: string;
  method: string;
  userId: string | null;
  userEmail: string | null;
  organizationId: string | null;
  createdAt: string;
  detail: Record<string, unknown>;
}

/** The gateway sends each field twice (snake and camel case); either is enough. */
export function readErrorEvent(item: ApiErrorEventItem): ErrorRow {
  return {
    id: item.id,
    status: item.statusCode ?? item.status_code,
    category: item.category,
    code: item.errorCode ?? item.error_code,
    endpoint: item.endpoint,
    method: item.httpMethod ?? item.http_method,
    userId: item.userId ?? item.user_id ?? null,
    userEmail: item.userEmail ?? item.user_email ?? null,
    organizationId: item.organizationId ?? item.organization_id ?? null,
    createdAt: item.createdAt ?? item.created_at,
    detail: isDict(item.detail) ? item.detail : {},
  };
}

export interface ErrorGroup {
  key: string;
  status: number;
  code: string;
  category: string;
  events: ErrorRow[];
  lastSeen: string;
}

/** The events of one page, grouped by status and code, the busiest group first. */
export function groupErrors(rows: ErrorRow[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const row of rows) {
    const key = `${row.status}:${row.code}`;
    const group = groups.get(key);
    if (group) {
      group.events.push(row);
      if (row.createdAt > group.lastSeen) group.lastSeen = row.createdAt;
    } else {
      groups.set(key, { key, status: row.status, code: row.code, category: row.category, events: [row], lastSeen: row.createdAt });
    }
  }
  return [...groups.values()].sort((a, b) => b.events.length - a.events.length || (a.lastSeen < b.lastSeen ? 1 : -1));
}

const MEANINGS: Record<string, string> = {
  quota_exceeded: 'A limit of the plan was reached. Expected: the account frees something, or asks for a larger agreement.',
  instance_complexity_too_large: 'The problem is bigger than the plan allows. The answer carries the estimated size and the plan’s limit when it could be measured.',
  binding_space_limit_unknown: 'The plan declares no limit for the problem size, so the request was refused. A fault in the plan’s configuration, not something the user did; a larger plan doesn’t fix it.',
  binding_space_over_technical_limit: 'The problem is bigger than this deployment accepts, whatever the plan. A larger plan doesn’t help; the user has to reduce the candidates.',
  binding_space_unmeasured: 'The size of the problem could not be measured, so it could not be checked against the limit. Worth a look: it is a fault of the service, not of the user.',
  pricing_misconfigured: 'A limit of the plan is missing or exceeds what the deployment can honour, so the request was refused. A fault in the plan’s configuration.',
  study_run_too_large: 'A study run expanded to more cells than this deployment allows per run. Refused whole, before anything was created.',
  usage_limit_exceeded: 'A period counter reported by the pricing service is spent. Nothing was started.',
  usage_limit_unknown: 'The pricing service did not report the usage of the account, so the request was refused. Retryable; worth a look if it persists.',
  concurrency_limit_exceeded: 'Too many jobs were running at once, under the plan’s limit or the deployment’s cap (the lower applies). Clients are told to retry after 15 s.',
  not_found: 'Something private or missing was asked for. The answer is the same either way, by design.',
  insufficient_api_key_permission: 'An API key lacked a permission the route needs.',
  unauthorized: 'A credential was missing or had expired.',
  pricing_unavailable: 'SPACE didn’t answer, so quotas couldn’t be checked and the request was refused.',
  not_a_draft: 'A version was published that isn’t a private draft.',
};

/** What an error code means in a sentence; a code the table doesn’t know falls back to its status. */
export function errorMeaning(code: string, status: number): string {
  if (MEANINGS[code]) return MEANINGS[code];
  if (status >= 500) return 'The platform or a service it depends on failed. This one is worth a look.';
  if (status === 402) return 'An allowance ran out.';
  if (status === 429) return 'Too many requests at once.';
  if (status === 422) return 'The request was refused because its content isn’t valid.';
  if (status === 409) return 'The request conflicted with the current state.';
  if (status === 404) return 'Nothing was found for the request.';
  if (status === 403) return 'The credential isn’t allowed to do this.';
  if (status === 401) return 'The request had no usable credential.';
  return 'The gateway refused the request.';
}

export function statusTone(status: number): ChipTone {
  if (status >= 500) return 'error';
  if (status === 402 || status === 429) return 'warning';
  return 'plain';
}
