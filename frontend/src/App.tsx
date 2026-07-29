import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Navigation } from './components/Navigation/Navigation';
import { Home } from './pages/Home/Home';
import { Playground } from './pages/Playground/Playground';
import { Engines } from './pages/Engines/Engines';
import { Schemas } from './pages/Schemas/Schemas';
import { Pricing } from './pages/Pricing/Pricing';
import { Login } from './pages/Auth/Login';
import { Register } from './pages/Auth/Register';
import { Account } from './pages/Account/Account';
import { Admin } from './pages/Admin/Admin';
import './styles/globals.css';
import './App.css';

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <div className="app-container">
            <Navigation />
            <main className="main-content">
              <Routes>
                {/* Open to visitors: everything except solving. */}
                <Route path="/" element={<Home />} />
                <Route path="/playground" element={<Playground />} />
                <Route path="/engines" element={<Engines />} />
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
            </main>
          </div>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
