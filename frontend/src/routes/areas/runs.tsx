import { lazy } from 'react';
import { live } from '../define';
import type { RouteDefinition } from '../types';

// Area: runs. Launching and following the runs of an organization.

const RunLaunch = lazy(() => import('../../pages/Runs/RunLaunch').then((module) => ({ default: module.RunLaunch })));
const RunList = lazy(() => import('../../pages/Runs/RunList').then((module) => ({ default: module.RunList })));
const RunDetail = lazy(() => import('../../pages/Runs/RunDetail').then((module) => ({ default: module.RunDetail })));

export const routes: RouteDefinition[] = [
  live('run-launch', '/app/:org/runs/new', <RunLaunch />),
  live('run-list', '/app/:org/runs', <RunList />),
  live('run-detail', '/app/:org/runs/:job', <RunDetail />),
];
