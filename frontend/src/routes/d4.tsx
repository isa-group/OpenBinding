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
const LibList = lazy(() => import('../pages/Library/LibList').then((module) => ({ default: module.LibList })));
const LibArtifact = lazy(() => import('../pages/Library/LibArtifact').then((module) => ({ default: module.LibArtifact })));
const LibDraft = lazy(() => import('../pages/Library/LibDraft').then((module) => ({ default: module.LibDraft })));
const LibVersion = lazy(() => import('../pages/Library/LibVersion').then((module) => ({ default: module.LibVersion })));
const ProjLibrary = lazy(() => import('../pages/Library/ProjLibrary').then((module) => ({ default: module.ProjLibrary })));
// The older library page: only `proj-resources` still points to it, until the task that rebuilds that screen replaces it.
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
  live('lib-list', '/app/:org/library', <LibList />),
  live('lib-artifact', '/app/:org/library/:artifact', <LibArtifact />),
  live('lib-draft', '/app/:org/library/:artifact/drafts/:draft', <LibDraft />),
  live('lib-version', '/app/:org/library/:artifact/versions/:version', <LibVersion />),
  live('proj-library', '/app/:org/:project/library', <ProjLibrary />),
  pending('proj-files', '/app/:org/:project/files'),
  live('proj-resources', '/app/:org/:project/resources', <ArtifactLibraryPage />),
  pending('proj-resource-detail', '/app/:org/:project/resources/:resource'),
  live('coll-list', '/app/:org/:project/collections', <CollectionsPage />),
  live('coll-detail', '/app/:org/:project/collections/:collection', <CollectionDetailPage />, { paramAliases: { collection: 'collectionSlug' } }),
  pending('gen-lab', '/app/generator'),
];
