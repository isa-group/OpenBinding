import { lazy } from 'react';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: runs. Launching and following jobs, and the generator lab.

const JobLaunch = lazy(() => import('../../pages/Jobs/JobLaunch').then((module) => ({ default: module.JobLaunch })));
const JobList = lazy(() => import('../../pages/Jobs/JobList').then((module) => ({ default: module.JobList })));
const JobDetail = lazy(() => import('../../pages/Jobs/JobDetail').then((module) => ({ default: module.JobDetail })));
const JobHistory = lazy(() => import('../../pages/Jobs/JobHistory').then((module) => ({ default: module.JobHistory })));
const GeneratorLab = lazy(() => import('../../pages/Generator/GeneratorLab').then((module) => ({ default: module.GeneratorLab })));

export const routes: RouteDefinition[] = [
  live('job-launch', '/app/:org/:project/jobs/new', <JobLaunch />),
  live('job-list', '/app/:org/:project/jobs', <JobList />),
  live('job-detail', '/app/:org/:project/jobs/:job', <JobDetail />),
  live('job-history', '/app/jobs', <JobHistory />),
  live('gen-lab', '/app/generator', <GeneratorLab />),
];

export const moved: MovedRoute[] = [];
