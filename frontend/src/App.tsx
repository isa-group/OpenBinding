import { SpaceProviderWrapper } from './modules/settings/contexts/SpaceProviderWrapper';
import { AuthProvider } from './modules/auth/contexts/authProvider';
import DialogHost from './modules/core/components/dialog-host';
import { ToastProvider } from './modules/core/contexts/toastContext';
import { useScrollToTop } from './modules/core/hooks/useScrollToTop';
import NotificationsSSEBridge from './modules/notification/components/notifications-sse-bridge';
import { NotificationsProvider } from './modules/notification/contexts/notificationsProvider';
import { OrganizationProvider } from './modules/organization/contexts/organizationProvider';
import Router from './routes/router';

// SPHERE's provider order (frontend/src/App.tsx), with OpenBinding's SPACE provider, which the /pricing gates need; the
// notifications' SSE stream turns what arrives into toasts.
function App() {
  useScrollToTop();

  return (
    <AuthProvider>
      <SpaceProviderWrapper>
        <OrganizationProvider>
          <NotificationsProvider>
            <ToastProvider>
              <NotificationsSSEBridge />
              <DialogHost />
              <Router />
            </ToastProvider>
          </NotificationsProvider>
        </OrganizationProvider>
      </SpaceProviderWrapper>
    </AuthProvider>
  );
}

export default App;
