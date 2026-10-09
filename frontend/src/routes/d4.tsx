import { lazy } from 'react';
import { live, pending } from './define';
import type { RouteDefinition } from './types';

// D4 · Authoring, cases & library (18 screens)

const CasesPage = lazy(() => import('../pages/Platform/PlatformPages').then((module) => ({ default: module.CasesPage })));
const CollectionsPage = lazy(() => import('../pages/Platform/PlatformPages').then((module) => ({ default: module.CollectionsPage })));
const CaseDetailPage = lazy(() => import('../pages/Platform/CaseDetailPage').then((module) => ({ default: module.CaseDetailPage })));
const CollectionDetailPage = lazy(() => import('../pages/Platform/CollectionDetailPage').then((module) => ({ default: module.CollectionDetailPage })));
const SnapshotPage = lazy(() => import('../pages/Platform/SnapshotPage').then((module) => ({ default: module.SnapshotPage })));
const ArtifactLibraryPage = lazy(() => import('../pages/Platform/ArtifactLibraryPage'));
const Playground = lazy(() => import('../pages/Playground/Playground').then((module) => ({ default: module.Playground })));

export const d4Routes: RouteDefinition[] = [
  live('case-list', '/app/:org/:project/cases', <CasesPage />),
  live('case-detail', '/app/:org/:project/cases/:case', <CaseDetailPage />, { paramAliases: { case: 'caseSlug' } }),
  pending('case-composer', '/app/:org/:project/cases/:case/compose'),
  pending('case-revision', '/app/:org/:project/cases/:case/revisions/:revision'),
  pending('case-compare', '/app/:org/:project/cases/:case/compare'),
  live('wb-workbench', '/app/:org/:project/workbench', <Playground />),
  live('snap-detail', '/app/:org/:project/snapshots/:snapshot', <SnapshotPage />, { paramAliases: { snapshot: 'snapshotId' } }),
  live('lib-list', '/app/:org/library', <ArtifactLibraryPage />),
  pending('lib-artifact', '/app/:org/library/:artifact'),
  pending('lib-draft', '/app/:org/library/:artifact/drafts/:draft'),
  pending('lib-version', '/app/:org/library/:artifact/versions/:version'),
  live('proj-library', '/app/:org/:project/library', <ArtifactLibraryPage />),
  pending('proj-files', '/app/:org/:project/files'),
  live('proj-resources', '/app/:org/:project/resources', <ArtifactLibraryPage />),
  pending('proj-resource-detail', '/app/:org/:project/resources/:resource'),
  live('coll-list', '/app/:org/:project/collections', <CollectionsPage />),
  live('coll-detail', '/app/:org/:project/collections/:collection', <CollectionDetailPage />, { paramAliases: { collection: 'collectionSlug' } }),
  pending('gen-lab', '/app/generator'),
];
