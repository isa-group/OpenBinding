import { lazy } from 'react';
import { Home } from '../../pages/Home/Home';
import { live } from '../define';
import type { RouteDefinition } from '../types';

// Area: public. The pages anybody can open without an account.

const About = lazy(() =>
  import('../../pages/About/About').then(module => ({ default: module.About }))
);
const WorkbenchPage = lazy(() =>
  import('../../pages/Public/PublicPages').then(module => ({ default: module.WorkbenchPage }))
);
const Pricing = lazy(() =>
  import('../../pages/Pricing/Pricing').then(module => ({ default: module.Pricing }))
);
const LanguagePage = lazy(() =>
  import('../../pages/Language/LanguagePage').then(module => ({ default: module.LanguagePage }))
);

export const routes: RouteDefinition[] = [
  live('pub-home', '/', <Home />),
  live('pub-workbench', '/workbench', <WorkbenchPage />),
  live('pub-about', '/about', <About />),
  live('pub-pricing', '/pricing', <Pricing />),
  live('pub-language', '/language', <LanguagePage />),
];
