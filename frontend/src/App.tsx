import { SpaceProviderWrapper } from './contexts/SpaceProviderWrapper';
import { AuthProvider } from './modules/auth/contexts/authProvider';
import Router from './routes/router';
import './styles/globals.css';
import './App.css';

function App() {
  return (
    <AuthProvider>
      <SpaceProviderWrapper>
        <Router />
      </SpaceProviderWrapper>
    </AuthProvider>
  );
}

export default App;
