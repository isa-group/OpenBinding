// The words of an upstream event (F6), shared by the badge, the renderer's events section, the change summary and the
// composition module's screens. Everything here names what the gateway stored; nothing is computed.

import type {
  EnvironmentUpstreamSummary,
  UpstreamEventView,
  UpstreamSummary,
} from '../../api/types';

export type UpstreamCategory = NonNullable<UpstreamSummary['worst']>;
export type UpstreamState = UpstreamEventView['state'];

/** A category in words, as the event list and the notifications say it. */
export const CATEGORY_WORDS: Record<UpstreamCategory, string> = {
  no_impact: 'No impact',
  values_changed: 'Values changed',
  binding_invalid: 'Rebinding recommended',
  offering_changed: 'Offering changed',
};

/** The badge tone of a category (SPHERE's `badgeTones` recipe). */
export const CATEGORY_TONE: Record<UpstreamCategory, 'amber' | 'rose' | 'sky' | 'neutral'> = {
  no_impact: 'neutral',
  values_changed: 'amber',
  binding_invalid: 'rose',
  offering_changed: 'sky',
};

/** A state in words. */
export const STATE_WORDS: Record<UpstreamState, string> = {
  open: 'Open',
  reviewed: 'Reviewed',
  resolved: 'Resolved',
};

/** The pricing an event names: its title, else its SPHERE family, else the host of its URL. */
export function pricingName(pricing: UpstreamEventView['pricing']): string {
  if (pricing.title) return pricing.title;
  if (pricing.sphere) return pricing.sphere;
  if (pricing.url) {
    try {
      return new URL(pricing.url).host;
    } catch {
      return pricing.url;
    }
  }
  return 'A pricing';
}

/** "2026-10 → 2026-11"; a source that is gone has no new side. */
export function versionsText(event: Pick<UpstreamEventView, 'old' | 'new'>): string {
  const before = event.old.label ?? 'the pinned version';
  if (!event.new) return `${before} → no longer readable`;
  return `${before} → ${event.new.label ?? 'a new version'}`;
}

/** "brevo 2026-10 → 2026-11". */
export function eventHeadline(event: Pick<UpstreamEventView, 'pricing' | 'old' | 'new'>): string {
  return `${pricingName(event.pricing)} ${versionsText(event)}`;
}

/** A badge tone (SPHERE's `badgeTones` recipe). */
export type BadgeTone = 'amber' | 'rose' | 'sky' | 'neutral';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What the counts say: the pill for open or reviewed events, and an environment's "resolved, not adopted here". */
export function upstreamBadgeText(upstream: UpstreamSummary | EnvironmentUpstreamSummary): {
  main: { tone: BadgeTone; text: string; title: string } | null;
  resolved: { text: string; title: string } | null;
} {
  const worst = upstream.worst ? CATEGORY_WORDS[upstream.worst] : null;
  const counted = [
    upstream.open > 0 ? plural(upstream.open, 'open upstream change', 'open upstream changes') : '',
    upstream.reviewed > 0 ? `${upstream.reviewed} reviewed` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const title = worst ? `${counted}. The worst: ${worst.toLowerCase()}.` : `${counted}.`;
  let main: { tone: BadgeTone; text: string; title: string } | null = null;
  if (upstream.bindingInvalid > 0) main = { tone: 'rose', text: 'Rebinding recommended', title };
  else if (upstream.open > 0)
    main = {
      tone: 'amber',
      text: plural(upstream.open, 'upstream change', 'upstream changes'),
      title,
    };
  else if (upstream.reviewed > 0)
    main = { tone: 'neutral', text: `${upstream.reviewed} reviewed`, title };
  const by = 'resolvedBy' in upstream ? upstream.resolvedBy : null;
  const resolved = by
    ? {
        text: `Resolved in ${by.version.label}, not adopted here`,
        title: `Version ${by.version.label} resolves an upstream change of the version in effect here; adopting it is a separate step.`,
      }
    : null;
  return { main, resolved };
}
