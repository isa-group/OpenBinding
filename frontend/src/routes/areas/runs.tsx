import { lazy } from 'react';
import { live } from '../define';
import type { RouteDefinition } from '../types';

// Area: runs. Launching and following the runs of an organization.

const JobLaunch = lazy(() => import('../../pages/Jobs/JobLaunch').then((module) => ({ default: module.JobLaunch })));
const JobList = lazy(() => import('../../pages/Jobs/JobList').then((module) => ({ default: module.JobList })));
const JobDetail = lazy(() => import('../../pages/Jobs/JobDetail').then((module) => ({ default: module.JobDetail })));

export const routes: RouteDefinition[] = [
  live('job-launch', '/app/:org/runs/new', <JobLaunch />),
  live('job-list', '/app/:org/runs', <JobList />),
  live('job-detail', '/app/:org/runs/:job', <JobDetail />),
];
