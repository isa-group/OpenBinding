import { Link } from 'react-router-dom';
import './PendingScreen.css';

/** Catch-all for addresses that are not part of the route registry (for example removed legacy routes). */
export function NotFoundScreen() {
  return (
    <section className="pending-screen" aria-labelledby="not-found-title">
      <span className="micro-label">404</span>
      <h1 id="not-found-title">Page not found</h1>
      <p>There is nothing at this address.</p>
      <p><Link to="/">Back to the home page</Link></p>
    </section>
  );
}
