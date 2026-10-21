/** Shown while a lazily loaded screen is being fetched. */
export function RouteFallback() {
  return (
    <div className="route-loading" role="status">
      <span className="status-dot" aria-hidden="true" /> Loading interface…
    </div>
  );
}
