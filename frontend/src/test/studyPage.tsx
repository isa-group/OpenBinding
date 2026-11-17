import type { ReactElement } from 'react';
import type { Organization } from '../modules/organization/api/organizationsApi';
import { orgNode, renderModule } from './moduleKit';

// Rendering the study screens (the card page `/studies/:org/:study/:tab?`, the form `/studies/new`) in a test: the account's
// organizations, which decide its role, the address, and a stand-in for anything else the page leads to.

/** The organizations the study tests sign in with: an owner's, a viewer's and a member's. */
export const STUDY_ORGS: Organization[] = [
  orgNode('isa-demo', { name: 'ISA Demo Group' }),
  orgNode('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' }),
  orgNode('team-lab', { name: 'Team Lab', effective_role: 'MEMBER' }),
];

export function renderStudyScreen(
  ui: ReactElement,
  options: { url: string; path?: string; organizations?: Organization[] }
) {
  return renderModule(ui, {
    path: options.path ?? '/studies/:org/:study/:tab?',
    entry: options.url,
    tree: options.organizations ?? STUDY_ORGS,
    routes: { '*': <p>elsewhere</p> },
  });
}
