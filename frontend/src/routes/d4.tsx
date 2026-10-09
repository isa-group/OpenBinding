import { lazy } from 'react';
import { live, pending } from './define';
import type { RouteDefinition } from './types';

// D4 · Authoring, cases & library (18 screens)

const CaseList = lazy(() => import('../pages/Cases/CaseList').then((module) => ({ default: module.CaseList })));
const CaseDetail = lazy(() => import('../pages/Cases/CaseDetail').then((module) => ({ default: module.CaseDetail })));
const SnapshotDetail = lazy(() => import('../pages/Cases/SnapshotDetail').then((module) => ({ default: module.SnapshotDetail })));
const CaseComposer = lazy(() => import('../pages/Cases/CaseComposer').then((module) => ({ default: module.CaseComposer })));
const CaseRevision = lazy(() => import('../pages/Cases/CaseRevision').then((module) => ({ default: module.CaseRevision })));
const CaseCompare = lazy(() => import('../pages/Cases/CaseCompare').then((module) => ({ default: module.CaseCompare })));
const CollectionsPage = lazy(() => import('../pages/Platform/PlatformPages').then((module) => ({ default: module.CollectionsPage })));
const CollectionDetailPage = lazy(() => import('../pages/Platform/CollectionDetailPage').then((module) => ({ default: module.CollectionDetailPage })));
const ArtifactLibraryPage = lazy(() => import('../pages/Platform/ArtifactLibraryPage'));
const Playground = lazy(() => import('../pages/Playground/Playground').then((module) => ({ default: module.Playground })));

export const d4Routes: RouteDefinition[] = [
  live('case-list', '/app/:org/:project/cases', <CaseList />),
  live('case-detail', '/app/:org/:project/cases/:case', <CaseDetail />),
  live('case-composer', '/app/:org/:project/cases/:case/compose', <CaseComposer />),
  live('case-revision', '/app/:org/:project/cases/:case/revisions/:revision', <CaseRevision />),
  live('case-compare', '/app/:org/:project/cases/:case/compare', <CaseCompare />),
  live('wb-workbench', '/app/:org/:project/workbench', <Playground />),
  live('snap-detail', '/app/:org/:project/snapshots/:snapshot', <SnapshotDetail />),
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
