import { lazy } from 'react';
import { live, pending } from './define';
import type { RouteDefinition } from './types';

// D8 · Administration & pricing control room (13 screens). Every one of them is admin-only.

const AdminOverview = lazy(() => import('../pages/Admin/AdminOverview').then((module) => ({ default: module.AdminOverview })));
const AdminUsers = lazy(() => import('../pages/Admin/AdminUsers').then((module) => ({ default: module.AdminUsers })));
const AdminUserDetail = lazy(() => import('../pages/Admin/AdminUserDetail').then((module) => ({ default: module.AdminUserDetail })));
const AdminAudit = lazy(() => import('../pages/Admin/AdminAudit').then((module) => ({ default: module.AdminAudit })));
const AdminErrors = lazy(() => import('../pages/Admin/AdminErrors').then((module) => ({ default: module.AdminErrors })));
const AdminQueues = lazy(() => import('../pages/Admin/AdminQueues').then((module) => ({ default: module.AdminQueues })));
const AdminSponsor = lazy(() => import('../pages/Admin/AdminSponsor').then((module) => ({ default: module.AdminSponsor })));
const PricingControlRoomPage = lazy(() => import('../pages/Platform/PricingControlRoom').then((module) => ({ default: module.PricingControlRoomPage })));

export const d8Routes: RouteDefinition[] = [
  live('admin-overview', '/app/admin', <AdminOverview />, { requireAdmin: true }),
  live('admin-users', '/app/admin/users', <AdminUsers />, { requireAdmin: true }),
  live('admin-user-detail', '/app/admin/users/:user', <AdminUserDetail />, { requireAdmin: true }),
  live('admin-audit', '/app/admin/audit', <AdminAudit />, { requireAdmin: true }),
  live('admin-errors', '/app/admin/errors', <AdminErrors />, { requireAdmin: true }),
  live('admin-queues', '/app/admin/queues', <AdminQueues />, { requireAdmin: true }),
  pending('admin-moderation', '/app/admin/moderation', { requireAdmin: true }),
  pending('admin-maintenance', '/app/admin/maintenance', { requireAdmin: true }),
  pending('admin-routing', '/app/admin/engine-routing', { requireAdmin: true }),
  live('admin-sponsor', '/app/admin/organizations/:org/sponsor', <AdminSponsor />, { requireAdmin: true }),
  live('admin-pricing', '/app/admin/pricing', <PricingControlRoomPage />, { requireAdmin: true }),
  pending('admin-pricing-draft', '/app/admin/pricing/drafts/new', { requireAdmin: true }),
  pending('admin-pricing-release', '/app/admin/pricing/:version', { requireAdmin: true }),
];
