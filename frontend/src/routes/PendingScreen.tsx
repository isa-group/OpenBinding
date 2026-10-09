import './PendingScreen.css';

/**
 * Temporary stand-in for a prototype screen whose page has not been rebuilt yet.
 * It is rendered inside the layout the screen belongs to and disappears once every
 * definition in the registry is live.
 */
export function PendingScreen({ id, path }: { id: string; path: string }) {
  return (
    <section className="pending-screen" data-screen-id={id} aria-labelledby="pending-screen-title">
      <span className="micro-label">Screen under construction</span>
      <h1 id="pending-screen-title">This screen is being rebuilt</h1>
      <p>The redesigned version of this page is not available yet. Its address is already reserved.</p>
      <dl>
        <div><dt>Screen</dt><dd><code>{id}</code></dd></div>
        <div><dt>Route</dt><dd><code>{path}</code></dd></div>
      </dl>
    </section>
  );
}
