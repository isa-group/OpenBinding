/** Shown while a lazily loaded screen is being fetched. */
export function RouteFallback() {
  return (
    <div
      className="route-loading flex items-center justify-center gap-2 p-16 text-sm text-tp-slate"
      role="status"
    >
      <span
        className="inline-block h-[0.45rem] w-[0.45rem] animate-pulse rounded-full bg-current"
        aria-hidden="true"
      />{' '}
      Loading interface…
    </div>
  );
}
