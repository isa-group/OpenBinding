import { lazy } from 'react';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: admin. Every one of them is admin-only. Pricing is administered in the SPACE and SPHERE consoles.
// The audit log, errors, queues and maintenance are sections of admin-overview (`/app/admin?section=`), not screens.

const AdminOverview = lazy(() => import('../../pages/Admin/AdminOverview').then((module) => ({ default: module.AdminOverview })));
const AdminUsers = lazy(() => import('../../pages/Admin/AdminUsers').then((module) => ({ default: module.AdminUsers })));
const AdminUserDetail = lazy(() => import('../../pages/Admin/AdminUserDetail').then((module) => ({ default: module.AdminUserDetail })));
const AdminModeration = lazy(() => import('../../pages/Admin/AdminModeration').then((module) => ({ default: module.AdminModeration })));

export const routes: RouteDefinition[] = [
  live('admin-overview', '/app/admin', <AdminOverview />, { requireAdmin: true }),
  live('admin-users', '/app/admin/users', <AdminUsers />, { requireAdmin: true }),
  live('admin-user-detail', '/app/admin/users/:user', <AdminUserDetail />, { requireAdmin: true }),
  live('admin-moderation', '/app/admin/moderation', <AdminModeration />, { requireAdmin: true }),
];

export const moved: MovedRoute[] = [];
