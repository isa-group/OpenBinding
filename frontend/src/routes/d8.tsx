import { lazy } from 'react';
import { Admin } from '../pages/Admin/Admin';
import { live, pending } from './define';
import type { RouteDefinition } from './types';

// D8 · Administration & pricing control room (13 screens). Every one of them is admin-only.

const PricingControlRoomPage = lazy(() => import('../pages/Platform/PricingControlRoom').then((module) => ({ default: module.PricingControlRoomPage })));

export const d8Routes: RouteDefinition[] = [
  live('admin-overview', '/app/admin', <Admin />, { requireAdmin: true }),
  pending('admin-users', '/app/admin/users', { requireAdmin: true }),
  pending('admin-user-detail', '/app/admin/users/:user', { requireAdmin: true }),
  pending('admin-audit', '/app/admin/audit', { requireAdmin: true }),
  pending('admin-errors', '/app/admin/errors', { requireAdmin: true }),
  pending('admin-queues', '/app/admin/queues', { requireAdmin: true }),
  pending('admin-moderation', '/app/admin/moderation', { requireAdmin: true }),
  pending('admin-maintenance', '/app/admin/maintenance', { requireAdmin: true }),
  pending('admin-routing', '/app/admin/engine-routing', { requireAdmin: true }),
  pending('admin-sponsor', '/app/admin/organizations/:org/sponsor', { requireAdmin: true }),
  live('admin-pricing', '/app/admin/pricing', <PricingControlRoomPage />, { requireAdmin: true }),
  pending('admin-pricing-draft', '/app/admin/pricing/drafts/new', { requireAdmin: true }),
  pending('admin-pricing-release', '/app/admin/pricing/:version', { requireAdmin: true }),
];
