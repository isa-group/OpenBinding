import { Link } from 'react-router-dom';
import { config } from '../../config';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-statement">
          <strong>One stable container. Many binding problem families.</strong>
          <p>
            BIM v1 composes profile-directed, typed resources into a pinned problem IR.
            OpenBinding is the reference host that validates, lowers, routes and verifies it.
          </p>
        </div>
        <nav className="site-footer-nav" aria-label="Explore BIM">
          <Link to="/" viewTransition>Understand</Link>
          <Link to="/profiles" viewTransition>Profiles &amp; dialects</Link>
          <Link to="/examples" viewTransition>Examples</Link>
          <Link to="/playground" viewTransition>Playground</Link>
          <Link to="/engines" viewTransition>Engine compatibility</Link>
          <Link to="/schemas" viewTransition>Specification</Link>
          <a href={`${config.apiBaseUrl}/docs`} target="_blank" rel="noreferrer">API reference ↗</a>
        </nav>
        <div className="site-footer-meta">
          <span>BIM v1 language framework</span>
          <span>Deterministic, immutable, capability-matched</span>
        </div>
      </div>
    </footer>
  );
}
