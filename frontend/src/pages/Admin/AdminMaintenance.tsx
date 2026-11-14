import { AdminFrame } from './AdminChrome';
import { AdminMaintenanceTools } from './AdminMaintenanceTools';

/** The maintenance section of admin-overview: preview what a retention period would touch, then purge expired data, and settle abandoned jobs. */
export function MaintenanceSection() {
  return (
    <AdminFrame
      section="maintenance"
      trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Maintenance' }]}
      title="Maintenance"
      lede="Preview first, then act. Every action here is recorded in the audit log; purging can’t be undone."
    >
      <AdminMaintenanceTools />
    </AdminFrame>
  );
}
