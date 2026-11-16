import { SpaceProviderWrapper } from './contexts/SpaceProviderWrapper';
import { AuthProvider } from './modules/auth/contexts/authProvider';
import DialogHost from './modules/core/components/dialog-host';
import { ToastProvider } from './modules/core/contexts/toastContext';
import { useScrollToTop } from './modules/core/hooks/useScrollToTop';
import { OrganizationProvider } from './modules/organization/contexts/organizationProvider';
import Router from './routes/router';
import './styles/globals.css';

// SPHERE's provider order (frontend/src/App.tsx), with OpenBinding's SPACE provider, which the /pricing gates need. The
// notifications provider and its SSE bridge join between the organizations and the toasts in B4.
function App() {
  useScrollToTop();

  return (
    <AuthProvider>
      <SpaceProviderWrapper>
        <OrganizationProvider>
          <ToastProvider>
            <DialogHost />
            <Router />
          </ToastProvider>
        </OrganizationProvider>
      </SpaceProviderWrapper>
    </AuthProvider>
  );
}

export default App;
