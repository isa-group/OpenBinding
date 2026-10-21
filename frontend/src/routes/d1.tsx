import { lazy } from 'react';
import { Home } from '../pages/Home/Home';
import { Engines } from '../pages/Engines/Engines';
import { Profiles } from '../pages/Profiles/Profiles';
import { Examples } from '../pages/Examples/Examples';
import { CasCallback } from '../pages/Auth/CasCallback';
import { Login } from '../pages/Auth/Login';
import { PasswordResetCompletePage, PasswordResetRequestPage } from '../pages/Auth/PasswordReset';
import { Register } from '../pages/Auth/Register';
import { live } from './define';
import type { RouteDefinition } from './types';

// D1 · Core, public & authentication (18 screens)

const ExplorePage = lazy(() => import('../pages/Public/Explore').then((module) => ({ default: module.ExplorePage })));
const Resolve = lazy(() => import('../pages/Resolve/Resolve').then((module) => ({ default: module.Resolve })));
const About = lazy(() => import('../pages/About/About').then((module) => ({ default: module.About })));
const Status = lazy(() => import('../pages/Status/Status').then((module) => ({ default: module.Status })));
const WorkbenchPage = lazy(() => import('../pages/Public/PublicPages').then((module) => ({ default: module.WorkbenchPage })));
const Schemas = lazy(() => import('../pages/Schemas/Schemas').then((module) => ({ default: module.Schemas })));
const EngineDetail = lazy(() => import('../pages/EngineDetail/EngineDetail').then((module) => ({ default: module.EngineDetail })));
const AcceptInvitation = lazy(() => import('../pages/Invitations/AcceptInvitation').then((module) => ({ default: module.AcceptInvitation })));
const States = lazy(() => import('../pages/System/States').then((module) => ({ default: module.States })));

export const d1Routes: RouteDefinition[] = [
  live('pub-home', '/', <Home />),
  live('pub-explore', '/explore', <ExplorePage />),
  live('pub-resolve', '/resolve/:kind/:digest', <Resolve />),
  live('eng-catalog', '/engines', <Engines />),
  live('eng-detail', '/engines/:namespace/:name/:version', <EngineDetail />),
  live('lang-profiles', '/language', <Profiles />),
  live('lang-schemas', '/language/schemas/:kind', <Schemas />),
  live('lang-examples', '/examples', <Examples />),
  live('pub-workbench', '/workbench', <WorkbenchPage />),
  live('pub-about', '/about', <About />),
  live('pub-status', '/status', <Status />),
  live('auth-login', '/login', <Login />),
  live('auth-register', '/register', <Register />),
  live('auth-reset-request', '/password-reset', <PasswordResetRequestPage />),
  live('auth-reset-complete', '/password-reset/complete', <PasswordResetCompletePage />),
  live('auth-cas-callback', '/auth/cas/callback', <CasCallback />),
  live('org-invite-accept', '/invitations/accept', <AcceptInvitation />, { sessionHeader: true }),
  live('sys-states', '/app/system/states', <States />),
];
