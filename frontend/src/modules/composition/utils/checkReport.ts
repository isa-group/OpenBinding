// The sentences of an environment's check report ("Check now"): one per source, built from the names the gateway answered.

import type { CheckUpstream, EnvironmentCheck } from '../../core/api/types';

/** How a row's status chip reads: the latest, something newer, or nothing to say. */
export type CheckTone = 'ok' | 'news' | 'muted';

export interface CheckRow {
  key: string;
  label: string;
  text: string;
  status: string;
  tone: CheckTone;
}

/** "danruilop1/brevo" → "Brevo": the pricing's own name, as SPHERE's path ends. */
function pricingName(sphere: string | null): string {
  const last = sphere?.split('/').pop() ?? '';
  return last ? `${last[0].toUpperCase()}${last.slice(1)}` : 'its pricing';
}

const STATUS: Record<CheckUpstream['status'] | 'none', { label: string; tone: CheckTone }> = {
  current: { label: 'Latest', tone: 'ok' },
  newer: { label: 'Newer', tone: 'news' },
  unavailable: { label: 'Unavailable', tone: 'muted' },
  not_snapshotted: { label: 'Not stored', tone: 'muted' },
  none: { label: 'No offering', tone: 'muted' },
};

/** The report as one sentence per source. */
export function checkRows(report: EnvironmentCheck): CheckRow[] {
  const rows: CheckRow[] = report.upstream.map(entry => {
    const name = pricingName(entry.sphere);
    const plan = entry.plan ? ` (plan ${entry.plan})` : '';
    const text =
      entry.status === 'current'
        ? `${name} ${entry.pinned?.name ?? ''} is the latest${plan}.`
        : entry.status === 'newer'
          ? `${name} ${entry.latest?.name ?? ''} is newer than the pinned ${entry.pinned?.name ?? 'version'}${plan}.`
          : entry.status === 'unavailable'
            ? `Could not reach SPHERE for ${name} just now; try again in a moment.`
            : `${name} has no stored pricing to compare.`;
    return {
      key: `task:${entry.task}`,
      label: entry.task,
      text: text.replace(/\s+/g, ' '),
      status: STATUS[entry.status].label,
      tone: STATUS[entry.status].tone,
    };
  });
  const offering = report.offering;
  const source = offering.source ? Object.values(offering.source)[0] : 'the offering';
  const offeringText =
    offering.status === 'current'
      ? `${source} ${offering.pinned?.versionName ?? ''} is the latest.`
      : offering.status === 'newer'
        ? `${source} ${offering.latest?.versionName ?? ''} is newer than ${offering.pinned?.versionName ?? 'the version'} read when this version was evaluated.`
        : offering.status === 'unavailable'
          ? `${source} could not be read just now; try again in a moment.`
          : 'This version names no offering.';
  rows.push({
    key: 'offering',
    label: 'Offering',
    text: offeringText.replace(/\s+/g, ' '),
    status: STATUS[offering.status].label,
    tone: STATUS[offering.status].tone,
  });
  const binding = report.binding;
  rows.push({
    key: 'binding',
    label: 'Binding',
    text:
      binding.status === 'valid'
        ? 'Valid on the installed toolchain.'
        : binding.status === 'declared'
          ? 'Declared values: there is no problem to check it against.'
          : `Not valid on the installed toolchain: ${binding.diagnostics.map(item => item.message).join(' ')}`,
    status:
      binding.status === 'invalid'
        ? 'Invalid'
        : binding.status === 'valid'
          ? 'Valid'
          : 'No problem',
    tone: binding.status === 'invalid' ? 'news' : binding.status === 'valid' ? 'ok' : 'muted',
  });
  return rows;
}
