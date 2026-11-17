/** What a broken screen shows unless the caller says otherwise. */
export default function ScreenFailed({ reload }: { reload: () => void }) {
  return (
    <div
      className="mx-auto flex max-w-[36rem] flex-col items-center px-4 py-24 text-center"
      role="alert"
    >
      <p className="text-xs font-semibold tracking-wide text-tp-steel uppercase">Error</p>
      <h1 className="mt-2 font-display text-3xl text-tp-ink">Something went wrong</h1>
      <p className="mt-3 text-sm text-tp-slate">
        This screen couldn’t be shown. Reload the page; if it happens again, go back to the home
        page.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reload}
          className="cursor-pointer rounded-md bg-tp-accent px-4 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-accent-hover"
        >
          Reload
        </button>
        <a href="/" className="text-sm font-medium text-tp-link hover:underline">
          Go to the home page
        </a>
      </div>
    </div>
  );
}
