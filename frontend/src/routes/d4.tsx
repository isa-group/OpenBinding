import { lazy } from 'react';
import { live } from './define';
import type { RouteDefinition } from './types';

// D4 · Authoring, cases & library (11 screens)

const CaseList = lazy(() => import('../pages/Cases/CaseList').then((module) => ({ default: module.CaseList })));
const CaseDetail = lazy(() => import('../pages/Cases/CaseDetail').then((module) => ({ default: module.CaseDetail })));
const SnapshotDetail = lazy(() => import('../pages/Cases/SnapshotDetail').then((module) => ({ default: module.SnapshotDetail })));
const CaseComposer = lazy(() => import('../pages/Cases/CaseComposer').then((module) => ({ default: module.CaseComposer })));
const CaseRevision = lazy(() => import('../pages/Cases/CaseRevision').then((module) => ({ default: module.CaseRevision })));
const CaseCompare = lazy(() => import('../pages/Cases/CaseCompare').then((module) => ({ default: module.CaseCompare })));
const ProjFiles = lazy(() => import('../pages/Resources/ProjFiles').then((module) => ({ default: module.ProjFiles })));
const CollList = lazy(() => import('../pages/Resources/CollList').then((module) => ({ default: module.CollList })));
const CollDetail = lazy(() => import('../pages/Resources/CollDetail').then((module) => ({ default: module.CollDetail })));
const Workbench = lazy(() => import('../pages/Workbench/Workbench').then((module) => ({ default: module.Workbench })));
const GeneratorLab = lazy(() => import('../pages/Generator/GeneratorLab').then((module) => ({ default: module.GeneratorLab })));

// [impl->req~frontend-retire-library-screens-not-routed~1]
// [impl->req~frontend-retire-library-screen-count~1]
export const d4Routes: RouteDefinition[] = [
  live('case-list', '/app/:org/:project/cases', <CaseList />),
  live('case-detail', '/app/:org/:project/cases/:case', <CaseDetail />),
  live('case-composer', '/app/:org/:project/cases/:case/compose', <CaseComposer />),
  live('case-revision', '/app/:org/:project/cases/:case/revisions/:revision', <CaseRevision />),
  live('case-compare', '/app/:org/:project/cases/:case/compare', <CaseCompare />),
  live('wb-workbench', '/app/:org/:project/workbench', <Workbench />),
  live('snap-detail', '/app/:org/:project/snapshots/:snapshot', <SnapshotDetail />),
  live('proj-files', '/app/:org/:project/files', <ProjFiles />),
  live('coll-list', '/app/:org/:project/collections', <CollList />),
  live('coll-detail', '/app/:org/:project/collections/:collection', <CollDetail />),
  live('gen-lab', '/app/generator', <GeneratorLab />),
];
