// First, and deliberately: styles/tailwind.css opens with the cascade layer statement, and a layer takes its place from
// where its name is first seen, so it has to be the first stylesheet the application loads.
import './styles/tailwind.css';

import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import { AuthConfigProvider } from './modules/auth/contexts/authConfig';
import SkeletonThemeProvider from './modules/core/components/skeleton-theme-provider';
import LoadingView from './modules/core/pages/loading';
import { applyBrand, initialBrand } from './modules/core/theme/brand';

// Before the first paint, so the page never flashes the other palette.
applyBrand(initialBrand());

// SPHERE's order (frontend/src/main.tsx): Helmet, the router, the skeleton theme, a loading view and the sign-in configuration
// (nothing of the application draws before the gateway has said how it signs people in) around the app.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HelmetProvider>
      <BrowserRouter>
        <SkeletonThemeProvider>
          <Suspense fallback={<LoadingView />}>
            <AuthConfigProvider>
              <App />
            </AuthConfigProvider>
          </Suspense>
        </SkeletonThemeProvider>
      </BrowserRouter>
    </HelmetProvider>
  </StrictMode>
);
