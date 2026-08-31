import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Navigation } from './components/Navigation/Navigation';
import { Home } from './pages/Home/Home';
import { Engines } from './pages/Engines/Engines';
import { RegisterEngine } from './pages/RegisterEngine/RegisterEngine';
import { Profiles } from './pages/Profiles/Profiles';
import { Examples } from './pages/Examples/Examples';
import { Login } from './pages/Auth/Login';
import { Register } from './pages/Auth/Register';
import { Account } from './pages/Account/Account';
import { Admin } from './pages/Admin/Admin';
import { SiteFooter } from './components/SiteFooter/SiteFooter';
import './styles/globals.css';
import './App.css';

// Keep the first educational step lean; the editor and schema tree load on demand.
const Playground = lazy(() => import('./pages/Playground/Playground').then((module) => ({ default: module.Playground })));
const Schemas = lazy(() => import('./pages/Schemas/Schemas').then((module) => ({ default: module.Schemas })));
const Pricing = lazy(() => import('./pages/Pricing/Pricing').then((module) => ({ default: module.Pricing })));

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <div className="app-container">
            <a className="skip-link" href="#main-content">Skip to content</a>
            <Navigation />
            <main id="main-content" className="main-content" tabIndex={-1}>
              <Suspense fallback={<div className="route-loading" role="status"><span className="status-dot" aria-hidden="true" /> Loading interface…</div>}>
              <Routes>
                {/* Public learning surface; Engine discovery and execution require an account. */}
                <Route path="/" element={<Home />} />
                <Route path="/playground" element={<ProtectedRoute><Playground /></ProtectedRoute>} />
                <Route path="/profiles" element={<Profiles />} />
                <Route path="/examples" element={<Examples />} />
                <Route path="/engines" element={<ProtectedRoute><Engines /></ProtectedRoute>} />
                {/* Registering needs an account: an engine belongs to somebody. */}
                <Route
                  path="/engines/new"
                  element={
                    <ProtectedRoute>
                      <RegisterEngine />
                    </ProtectedRoute>
                  }
                />
                <Route path="/schemas" element={<Schemas />} />
                <Route path="/pricing" element={<Pricing />} />
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />

                {/* The guard is a courtesy; the gateway guards these itself. */}
                <Route
                  path="/account"
                  element={
                    <ProtectedRoute>
                      <Account />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <ProtectedRoute requireAdmin>
                      <Admin />
                    </ProtectedRoute>
                  }
                />
              </Routes>
              </Suspense>
            </main>
            <SiteFooter />
          </div>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
