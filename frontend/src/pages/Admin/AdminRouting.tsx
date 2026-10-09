import { AdminOnly } from './AdminChrome';
import { AdminAutoRouter } from './AdminAutoRouter';

/** admin-routing: AutoRouter health and drift per engine, the observations it learns from, and recalibration. Administrators only. */
export function AdminRouting() {
  return <AdminOnly><AdminAutoRouter /></AdminOnly>;
}
