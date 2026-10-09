import { AdminFrame, AdminOnly } from './AdminChrome';
import { AdminMaintenanceTools } from './AdminMaintenanceTools';

/** admin-maintenance: preview what a retention period would touch, then purge expired data, settle abandoned jobs and renew expired contracts. */
export function AdminMaintenance() {
  return (
    <AdminOnly>
      <AdminFrame
        section="maintenance"
        trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Maintenance' }]}
        title="Maintenance"
        lede="Preview first, then act. Every action here is recorded in the audit log; purging can’t be undone."
      >
        <AdminMaintenanceTools />
      </AdminFrame>
    </AdminOnly>
  );
}
