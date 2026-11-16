// Adapted from SPHERE frontend/src/modules/core/pages/loading/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: theme tokens instead of the undefined `sphere-grey-300` and `sphere-primary-700` classes; a status role.

export default function LoadingView() {
  return (
    <div className="mx-auto max-w-screen-xl px-4">
      <div className="mx-auto flex min-h-[80vh] max-w-[480px] flex-col items-center justify-center py-12 text-center">
        <div
          className="h-10 w-10 animate-spin rounded-full border-4 border-tp-hairline-soft border-t-tp-primary"
          role="status"
          aria-label="Loading"
        />
      </div>
    </div>
  );
}
