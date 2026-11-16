// Design follows SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a); no code copied
import { Link } from 'react-router-dom';
import { ExternalLink, GitFork, Link2 } from 'lucide-react';
import { Action } from '../../../components/ui/Action';
import { useCopy } from '../../../components/ui/useCopy';
import { kindLabel } from '../../../entities/composition/kinds';
import type { CompositionViewModel, OfferingModel } from '../../../entities/composition/viewModel';
import { formatDate } from '../../../utils/format';
import type { Section } from '../presets';
import { RendererSection } from '../RendererSection';
import { ArchitectureMode } from './architecture';
import { CatalogMode } from './catalog';
import { WorkflowMode } from './workflow';

/**
 * The showcase mode: the public page of a composition, drawn only from what its documents say. Who it is and what it does, its values
 * with how far they can be trusted, the workflow with each task's candidate, the providers and the upstream plans the candidates come
 * from (reference cards: no pricing document is held for them yet), the problem it links named as text, its own pricing as a
 * reference, and its versions. It never shows the problem's candidates, an evaluation's findings or what-if analysis: a reader who is
 * not a member only reads (C3). Forking is the page's: the mode only says it was asked for.
 */

/** A version the page can open, as the showcase lists it. */
export interface ShowcaseVersion {
  id: string;
  label: string;
  /** When it was sealed. */
  createdAt: string;
}

export interface ShowcaseActions {
  /** The versions the reader may open, newest first. */
  versions: readonly ShowcaseVersion[];
  /** The public page of a version (`?version=<label>`). */
  versionHref: (label: string) => string;
  /** The address of the version shown, whole, to copy as its permalink. */
  permalink: string;
  /** When the composition last changed; null when the page does not know. */
  updatedAt?: string | null;
  /** Fork the version shown. Without it the page offers no fork (no version is loaded yet). */
  onFork?: () => void;
  /** The composition in the app, for a member of its organization; without it the app is not offered. */
  appHref?: string | null;
}

interface ShowcaseModeProps {
  model: CompositionViewModel;
  sections: readonly Section[];
  actions?: ShowcaseActions;
}

/** The composition's own pricing, as a reference: SPHERE pricings have no address of their own here yet (A12). */
function OfferingLine({ offering }: { offering: OfferingModel }) {
  if (offering.source === 'url' && offering.href) {
    return (
      <p className="cr-muted">
        <a href={offering.href} rel="noreferrer" target="_blank">{offering.label}<ExternalLink aria-hidden="true" className="cr-icon" /></a>
      </p>
    );
  }
  if (offering.source === 'registry') {
    // The label is `owner/name on <alias>`, and neither part holds a space.
    const at = offering.label.lastIndexOf(' on ');
    return <p className="cr-muted"><code>{offering.label.slice(0, at)}</code> on the on-premise SPHERE <code>{offering.label.slice(at + 4)}</code></p>;
  }
  return <p className="cr-muted"><code>{offering.label}</code> in SPHERE</p>;
}

function CopyPermalink({ permalink }: { permalink: string }) {
  const { copy, status } = useCopy();
  const said = status();
  return (
    <>
      <Action variant="secondary" size="sm" onClick={() => void copy(permalink)}>
        <Link2 aria-hidden="true" className="cr-icon" />
        Copy permalink
      </Action>
      <span role="status" className="cr-copied">
        {said === 'copied' ? 'Link copied.' : said === 'failed' ? 'The browser refused to copy; the address bar holds the same link.' : ''}
      </span>
    </>
  );
}

export function ShowcaseMode({ model, sections, actions }: ShowcaseModeProps) {
  const shows = (section: Section) => sections.includes(section);
  const only = (...wanted: Section[]) => wanted.filter(shows);
  const { identity, version, status } = model;
  const updated = formatDate(actions?.updatedAt);
  const sealed = version ? formatDate(version.createdAt) : null;

  return (
    <>
      {shows('identity') && (
        <header className="cr-showcase-head">
          <div className="cr-showcase-title">
            <span className="cr-kind">{kindLabel(identity.kind)} · {identity.orgName}</span>
            <h1>{identity.name}</h1>
            <p className="cr-muted">
              {version ? <>Version <code>{version.label}</code>{sealed && `, sealed ${sealed}`}</> : 'No version yet'}
              {updated && ` · Updated ${updated}`}
            </p>
          </div>
          {actions && (
            <div className="cr-showcase-actions">
              {actions.appHref && <Action to={actions.appHref} variant="secondary" size="sm">Open in the app</Action>}
              {actions.onFork && (
                <Action variant="primary" size="sm" onClick={actions.onFork}>
                  <GitFork aria-hidden="true" className="cr-icon" />
                  Fork
                </Action>
              )}
              <CopyPermalink permalink={actions.permalink} />
            </div>
          )}
        </header>
      )}

      {shows('about') && identity.description && (
        <RendererSection title="What it does">
          <p className="cr-about">{identity.description}</p>
        </RendererSection>
      )}

      {!version ? <p className="cr-muted">No version yet: nothing has been sealed for this composition.</p> : (
        <>
          <CatalogMode model={model} sections={only('status', 'values')} />
          <WorkflowMode model={model} sections={only('graph')} />
          <ArchitectureMode model={model} sections={only('providers', 'plans')} />

          {shows('problem') && status.problemRef && (
            <RendererSection title="Problem">
              <p className="cr-muted">
                The values were computed against the problem <code>{status.problemRef}</code>. The problem itself, its runs and the
                evaluation’s findings are not shown here.
              </p>
            </RendererSection>
          )}

          {shows('offering') && (
            <RendererSection title="Offering">
              {model.offering ? <OfferingLine offering={model.offering} /> : <p className="cr-muted">This version names no pricing of its own.</p>}
              <p className="cr-muted">Plans and prices arrive when OpenBinding reads the offering.</p>
            </RendererSection>
          )}
        </>
      )}

      {shows('versions') && actions && actions.versions.length > 0 && (
        <RendererSection title="Versions">
          <ol className="cr-versions" aria-label="Versions">
            {actions.versions.map((item) => (
              <li key={item.id}>
                <Link to={actions.versionHref(item.label)} aria-current={item.id === version?.id ? 'page' : undefined}>
                  <code>{item.label}</code>
                </Link>
                <span className="cr-muted">{formatDate(item.createdAt) ?? ''}</span>
              </li>
            ))}
          </ol>
        </RendererSection>
      )}
    </>
  );
}
