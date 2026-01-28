import { Link, useLocation } from 'react-router-dom';
import { useTheme } from '../../contexts/ThemeContext';
import { config } from '../../config';
import './Navigation.css';

export function Navigation() {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;

  const logoSrc = theme === 'light' ? '/logo-light.png' : '/logo.png';

  return (
    <nav className="navigation">
      <div className="nav-container">
        <div className="nav-brand">
          <Link to="/" className="brand-link">
            <img src={logoSrc} alt="OpenBinding" className="brand-logo" />
            <span className="brand-name">{config.name}</span>
          </Link>
        </div>

        <div className="nav-links">
          <Link 
            to="/" 
            className={`nav-link ${isActive('/') ? 'nav-link-active' : ''}`}
          >
            Home
          </Link>
          <Link 
            to="/playground" 
            className={`nav-link ${isActive('/playground') ? 'nav-link-active' : ''}`}
          >
            Playground
          </Link>
          <Link 
            to="/engines" 
            className={`nav-link ${isActive('/engines') ? 'nav-link-active' : ''}`}
          >
            Engines
          </Link>
          <Link 
            to="/schemas" 
            className={`nav-link ${isActive('/schemas') ? 'nav-link-active' : ''}`}
          >
            Schemas
          </Link>
          <a 
            href={`${config.apiBaseUrl}/docs`}
            target="_blank"
            rel="noopener noreferrer"
            className="nav-link"
          >
            API Docs ↗
          </a>
        </div>

        <div className="nav-actions">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
        </div>
      </div>
    </nav>
  );
}
