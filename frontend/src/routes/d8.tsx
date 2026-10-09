import { lazy } from 'react';
import { live } from './define';
import type { RouteDefinition } from './types';

// D8 · Administration & pricing control room (13 screens). Every one of them is admin-only.

const AdminOverview = lazy(() => import('../pages/Admin/AdminOverview').then((module) => ({ default: module.AdminOverview })));
const AdminUsers = lazy(() => import('../pages/Admin/AdminUsers').then((module) => ({ default: module.AdminUsers })));
const AdminUserDetail = lazy(() => import('../pages/Admin/AdminUserDetail').then((module) => ({ default: module.AdminUserDetail })));
const AdminAudit = lazy(() => import('../pages/Admin/AdminAudit').then((module) => ({ default: module.AdminAudit })));
const AdminErrors = lazy(() => import('../pages/Admin/AdminErrors').then((module) => ({ default: module.AdminErrors })));
const AdminQueues = lazy(() => import('../pages/Admin/AdminQueues').then((module) => ({ default: module.AdminQueues })));
const AdminModeration = lazy(() => import('../pages/Admin/AdminModeration').then((module) => ({ default: module.AdminModeration })));
const AdminMaintenance = lazy(() => import('../pages/Admin/AdminMaintenance').then((module) => ({ default: module.AdminMaintenance })));
const AdminRouting = lazy(() => import('../pages/Admin/AdminRouting').then((module) => ({ default: module.AdminRouting })));
const AdminSponsor = lazy(() => import('../pages/Admin/AdminSponsor').then((module) => ({ default: module.AdminSponsor })));
const PricingControlRoomPage = lazy(() => import('../pages/Platform/PricingControlRoom').then((module) => ({ default: module.PricingControlRoomPage })));
const AdminPricingDraft = lazy(() => import('../pages/Admin/AdminPricingDraft').then((module) => ({ default: module.AdminPricingDraft })));
const AdminPricingRelease = lazy(() => import('../pages/Admin/AdminPricingRelease').then((module) => ({ default: module.AdminPricingRelease })));

export const d8Routes: RouteDefinition[] = [
  live('admin-overview', '/app/admin', <AdminOverview />, { requireAdmin: true }),
  live('admin-users', '/app/admin/users', <AdminUsers />, { requireAdmin: true }),
  live('admin-user-detail', '/app/admin/users/:user', <AdminUserDetail />, { requireAdmin: true }),
  live('admin-audit', '/app/admin/audit', <AdminAudit />, { requireAdmin: true }),
  live('admin-errors', '/app/admin/errors', <AdminErrors />, { requireAdmin: true }),
  live('admin-queues', '/app/admin/queues', <AdminQueues />, { requireAdmin: true }),
  live('admin-moderation', '/app/admin/moderation', <AdminModeration />, { requireAdmin: true }),
  live('admin-maintenance', '/app/admin/maintenance', <AdminMaintenance />, { requireAdmin: true }),
  live('admin-routing', '/app/admin/engine-routing', <AdminRouting />, { requireAdmin: true }),
  live('admin-sponsor', '/app/admin/organizations/:org/sponsor', <AdminSponsor />, { requireAdmin: true }),
  live('admin-pricing', '/app/admin/pricing', <PricingControlRoomPage />, { requireAdmin: true }),
  live('admin-pricing-draft', '/app/admin/pricing/drafts/new', <AdminPricingDraft />, { requireAdmin: true }),
  live('admin-pricing-release', '/app/admin/pricing/:version', <AdminPricingRelease />, { requireAdmin: true }),
];
