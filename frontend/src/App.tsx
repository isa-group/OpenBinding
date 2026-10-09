import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { SpaceProviderWrapper } from './contexts/SpaceProviderWrapper';
import { AppRoutes } from './routes';
import './styles/globals.css';
import './App.css';

function App() {
  return (
    <AuthProvider>
      <SpaceProviderWrapper>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </SpaceProviderWrapper>
    </AuthProvider>
  );
}

export default App;
