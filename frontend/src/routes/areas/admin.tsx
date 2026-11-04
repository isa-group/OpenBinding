import { lazy } from 'react';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// [impl->req~frontend-retire-sponsorship-screen-not-routed~1]
// [impl->req~frontend-retire-sponsorship-screen-count~1]
// Area: admin. Every one of them is admin-only. Pricing is administered in the SPACE and SPHERE consoles.

const AdminOverview = lazy(() => import('../../pages/Admin/AdminOverview').then((module) => ({ default: module.AdminOverview })));
const AdminUsers = lazy(() => import('../../pages/Admin/AdminUsers').then((module) => ({ default: module.AdminUsers })));
const AdminUserDetail = lazy(() => import('../../pages/Admin/AdminUserDetail').then((module) => ({ default: module.AdminUserDetail })));
const AdminAudit = lazy(() => import('../../pages/Admin/AdminAudit').then((module) => ({ default: module.AdminAudit })));
const AdminErrors = lazy(() => import('../../pages/Admin/AdminErrors').then((module) => ({ default: module.AdminErrors })));
const AdminQueues = lazy(() => import('../../pages/Admin/AdminQueues').then((module) => ({ default: module.AdminQueues })));
const AdminModeration = lazy(() => import('../../pages/Admin/AdminModeration').then((module) => ({ default: module.AdminModeration })));
const AdminMaintenance = lazy(() => import('../../pages/Admin/AdminMaintenance').then((module) => ({ default: module.AdminMaintenance })));

export const routes: RouteDefinition[] = [
  live('admin-overview', '/app/admin', <AdminOverview />, { requireAdmin: true }),
  live('admin-users', '/app/admin/users', <AdminUsers />, { requireAdmin: true }),
  live('admin-user-detail', '/app/admin/users/:user', <AdminUserDetail />, { requireAdmin: true }),
  live('admin-audit', '/app/admin/audit', <AdminAudit />, { requireAdmin: true }),
  live('admin-errors', '/app/admin/errors', <AdminErrors />, { requireAdmin: true }),
  live('admin-queues', '/app/admin/queues', <AdminQueues />, { requireAdmin: true }),
  live('admin-moderation', '/app/admin/moderation', <AdminModeration />, { requireAdmin: true }),
  live('admin-maintenance', '/app/admin/maintenance', <AdminMaintenance />, { requireAdmin: true }),
];

export const moved: MovedRoute[] = [];
