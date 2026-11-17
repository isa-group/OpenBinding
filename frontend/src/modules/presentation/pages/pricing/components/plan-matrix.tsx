import { useState, type CSSProperties } from 'react';
import { MdCheck, MdExpandLess, MdExpandMore, MdRemove } from 'react-icons/md';
import { Chip } from '../../../../core/components/chip';
import type { Cell, PricingView, RowGroup } from '../../../../core/utils/pricing/pricingModel';
import PlanCta from './plan-cta';

/** Groups that start open: the first two feature groups and the monthly allowances. */
function openByDefault(groupId: string, index: number): boolean {
  return index < 2 || groupId === 'limit-monthly';
}

/** The plan tiles' fills, in the order of the document. */
const TONES = [
  'from-tp-primary to-tp-primary-deep',
  'from-tp-sunshine-800 to-tp-primary',
  'from-tp-primary-deep to-tp-ink',
  'from-tp-sunshine-900 to-tp-primary-deep',
] as const;

function CellView({ cell }: { cell: Cell }) {
  switch (cell.kind) {
    case 'yes':
      return (
        <span className="inline-flex items-center gap-1 text-[13px] font-medium text-tp-accent">
          <MdCheck
            className="h-[18px] w-[18px] shrink-0 rounded-full bg-tp-accent p-0.5 text-tp-on-primary"
            aria-hidden="true"
          />
          Included
        </span>
      );
    case 'no':
      return (
        <span className="inline-flex items-center gap-1 text-[13px] text-tp-steel">
          <MdRemove className="h-[18px] w-[18px] shrink-0 text-tp-muted" aria-hidden="true" />
          Not included
        </span>
      );
    case 'addon':
      return <span className="inline-flex text-[13px] text-tp-slate">With add-on</span>;
    case 'value':
      return (
        <>
          <span className="inline-block rounded-full bg-tp-accent px-3 py-[3px] text-[13px] font-bold text-tp-on-primary">
            {cell.text}
          </span>
          {cell.exact && (
            <span className="mt-0.5 block text-[11px] text-tp-steel">{cell.exact}</span>
          )}
        </>
      );
  }
}

interface PlanMatrixProps {
  view: PricingView;
  /** `all`, or the plan whose column is highlighted. */
  highlight: string;
  /** The account's plan, or `null` for a visitor. */
  plan: string | null;
  onContact: (plan: string) => void;
}

/**
 * The comparison: one column per plan, the features and limits in collapsible groups of rows. On a phone there is no room for
 * the plan columns, so nothing scrolls sideways: the plans are a two-column grid and every row becomes one block, its name on
 * top and one labelled value per plan beneath.
 */
export default function PlanMatrix({ view, highlight, plan, onContact }: PlanMatrixProps) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());

  const isOpen = (group: RowGroup, index: number) =>
    openByDefault(group.id, index) !== toggled.has(group.id);
  const toggle = (id: string) =>
    setToggled(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const highlightIndex =
    highlight === 'all' ? -1 : view.plans.findIndex(item => item.id === highlight);

  return (
    <div data-part="matrix-scroller" className="sm:overflow-x-auto">
      <div
        className="flex flex-col gap-4 [--pricing-first:148px] sm:min-w-[620px] md:min-w-[760px] md:[--pricing-first:240px]"
        style={{ '--pricing-columns': view.plans.length } as CSSProperties}
      >
        <div
          className="grid grid-cols-2 gap-x-2 gap-y-3 sm:grid-cols-[var(--pricing-first)_repeat(var(--pricing-columns),minmax(0,1fr))] sm:gap-2"
          role="list"
          aria-label="Plans"
        >
          <span aria-hidden="true" className="hidden sm:block" />
          {view.plans.map((item, index) => {
            const current = plan === item.id;
            const picked = highlightIndex === index;
            return (
              <div key={item.id} role="listitem" className="flex flex-col items-center gap-2">
                <div
                  data-part="plan-tile"
                  data-picked={picked || undefined}
                  className={`flex h-[104px] w-full flex-col items-center justify-center rounded-xl bg-linear-to-br p-2 text-center text-tp-on-primary sm:h-[124px] ${TONES[index % TONES.length]} ${picked ? 'ring-2 ring-tp-primary ring-offset-2 ring-offset-tp-canvas' : ''}`}
                >
                  <span className="text-xl font-bold tracking-[0.05em] uppercase">{item.id}</span>
                  <span className="text-base font-semibold">{item.priceLabel}</span>
                  <span className="text-xs opacity-90">{item.unitLabel}</span>
                </div>
                <span className="min-h-[34px] text-center text-xs leading-snug text-tp-slate">
                  {item.description}
                </span>
                {current && <Chip tone="accent">Your current plan</Chip>}
                <PlanCta
                  plan={item}
                  signedIn={plan !== null}
                  current={current}
                  onContact={onContact}
                />
              </div>
            );
          })}
        </div>

        {view.groups.map((group, groupIndex) => {
          const open = isOpen(group, groupIndex);
          const panelId = `pricing-group-${group.id}`;
          return (
            <section
              key={group.id}
              className="overflow-hidden rounded-2xl border border-tp-hairline shadow-elevation-1"
            >
              <h3 className="m-0 text-[15px]">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => toggle(group.id)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 bg-tp-surface px-5 py-3.5 text-left font-semibold text-tp-ink"
                >
                  <span>
                    {group.title}{' '}
                    <span className="text-[13px] font-normal text-tp-steel">· {group.note}</span>
                  </span>
                  {open ? (
                    <MdExpandLess className="h-4 w-4 shrink-0 text-tp-steel" aria-hidden="true" />
                  ) : (
                    <MdExpandMore className="h-4 w-4 shrink-0 text-tp-steel" aria-hidden="true" />
                  )}
                </button>
              </h3>
              {open && (
                <table
                  id={panelId}
                  data-part="matrix-table"
                  className="block w-full border-collapse sm:table sm:table-fixed"
                >
                  <caption className="sr-only">
                    {group.title}: {group.note}
                  </caption>
                  <thead className="sr-only">
                    <tr>
                      <th scope="col">{group.title}</th>
                      {view.plans.map(item => (
                        <th key={item.id} scope="col">
                          {item.id}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="block sm:table-row-group">
                    {group.rows.map(row => (
                      <tr
                        key={row.id}
                        className="grid grid-cols-2 gap-x-2 gap-y-1.5 border-t border-tp-hairline-soft px-3.5 py-3 sm:table-row sm:p-0"
                      >
                        <th
                          scope="row"
                          className="col-span-full p-0 text-left align-middle font-normal sm:w-[var(--pricing-first)] sm:px-3 sm:py-2.5 md:px-5 md:py-3"
                        >
                          <span className="block font-semibold text-tp-charcoal">{row.name}</span>
                          <span className="block text-xs text-tp-steel">{row.description}</span>
                          {row.appliesTo.length > 0 && (
                            <span className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-tp-steel">
                              Applies to
                              {row.appliesTo.map(name => (
                                <span
                                  key={name}
                                  className="rounded-full border border-tp-beige-deep bg-tp-surface-cream px-2 text-tp-accent"
                                >
                                  {name}
                                </span>
                              ))}
                            </span>
                          )}
                        </th>
                        {row.cells.map((cell, index) => {
                          const picked = highlightIndex === index;
                          return (
                            <td
                              key={view.plans[index].id}
                              data-plan={view.plans[index].id}
                              data-picked={picked || undefined}
                              title={cell.kind === 'value' ? cell.exact : undefined}
                              className={`flex min-w-0 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left before:text-[11px] before:font-semibold before:tracking-[0.08em] before:text-tp-steel before:content-[attr(data-plan)] sm:table-cell sm:rounded-none sm:px-1 sm:text-center sm:align-middle sm:before:content-none ${picked ? 'bg-tp-primary/8' : ''}`}
                            >
                              <CellView cell={cell} />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
