import { MdOpenInNew } from 'react-icons/md';
import type { CompositionViewModel, OfferingModel } from '../../../utils/composition/viewModel';
import type { Section } from '../presets';
import { RendererSection } from '../RendererSection';
import { ArchitectureMode } from './architecture';
import { CatalogMode } from './catalog';
import { WorkflowMode } from './workflow';

/**
 * The showcase mode: a composition drawn only from what its documents say, for every reader of the composition page. What it
 * does, its values with how far they can be trusted, the workflow with each task's candidate, the providers and the upstream plans
 * the candidates come from (reference cards: no pricing document is held for them yet), the problem it links named as text, and its
 * own pricing as a reference. It never shows the problem's candidates, an evaluation's findings or what-if analysis. The page's
 * header names the composition and holds its versions, links and actions.
 */

interface ShowcaseModeProps {
  model: CompositionViewModel;
  sections: readonly Section[];
}

/** The composition's own pricing, as a reference: SPHERE pricings have no address of their own here yet (A12). */
function OfferingLine({ offering }: { offering: OfferingModel }) {
  if (offering.source === 'url' && offering.href) {
    return (
      <p className="cr-muted m-0 text-[13px] text-tp-steel">
        <a href={offering.href} rel="noreferrer" target="_blank">
          {offering.label}
          <MdOpenInNew aria-hidden="true" className="cr-icon inline h-4 w-4 flex-none" />
        </a>
      </p>
    );
  }
  if (offering.source === 'registry') {
    // The label is `owner/name on <alias>`, and neither part holds a space.
    const at = offering.label.lastIndexOf(' on ');
    return (
      <p className="cr-muted m-0 text-[13px] text-tp-steel">
        <code>{offering.label.slice(0, at)}</code> on the on-premise SPHERE{' '}
        <code>{offering.label.slice(at + 4)}</code>
      </p>
    );
  }
  return (
    <p className="cr-muted m-0 text-[13px] text-tp-steel">
      <code>{offering.label}</code> in SPHERE
    </p>
  );
}

export function ShowcaseMode({ model, sections }: ShowcaseModeProps) {
  const shows = (section: Section) => sections.includes(section);
  const only = (...wanted: Section[]) => wanted.filter(shows);
  const { identity, version, status } = model;

  return (
    <>
      {shows('about') && identity.description && (
        <RendererSection title="What it does">
          <p className="cr-about m-0 max-w-[720px] [overflow-wrap:anywhere] text-tp-slate">
            {identity.description}
          </p>
        </RendererSection>
      )}

      {!version ? (
        <p className="cr-muted m-0 text-[13px] text-tp-steel">
          No version yet: nothing has been sealed for this composition.
        </p>
      ) : (
        <>
          <CatalogMode model={model} sections={only('status', 'values')} />
          <WorkflowMode model={model} sections={only('graph')} />
          <ArchitectureMode model={model} sections={only('providers', 'plans')} />

          {shows('problem') && status.problemRef && (
            <RendererSection title="Problem">
              <p className="cr-muted m-0 text-[13px] text-tp-steel">
                The values were computed against the problem <code>{status.problemRef}</code>. The
                problem itself, its runs and the evaluation’s findings are not shown here.
              </p>
            </RendererSection>
          )}

          {shows('offering') && (
            <RendererSection title="Offering">
              {model.offering ? (
                <OfferingLine offering={model.offering} />
              ) : (
                <p className="cr-muted m-0 text-[13px] text-tp-steel">
                  This version names no pricing of its own.
                </p>
              )}
              <p className="cr-muted m-0 text-[13px] text-tp-steel">
                Plans and prices arrive when OpenBinding reads the offering.
              </p>
            </RendererSection>
          )}
        </>
      )}
    </>
  );
}
