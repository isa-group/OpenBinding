// Adapted from SPHERE frontend/src/modules/presentation/pages/home/components/call-to-action.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's call to action (the account, or the dashboard when signed in); the theme's ink instead of hex;
// the display font of the theme.

import IslandButton from './island-button';
import RevealBlock from './reveal-block';

export default function CallToAction({ signedIn }: { signedIn: boolean }) {
  return (
    <RevealBlock className="mt-24 rounded-[2rem] border border-white/15 bg-white/[0.06] p-1.5 ring-1 ring-white/10">
      <section
        aria-label="Get started"
        className="rounded-[calc(2rem-0.375rem)] border border-white/15 bg-tp-ink px-6 py-12 shadow-[inset_0_1px_1px_rgba(255,255,255,0.14)] md:px-12 md:py-16"
      >
        <span className="inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] font-medium tracking-[0.22em] text-white/80 uppercase">
          Ready when you are
        </span>
        <h2 className="mt-6 max-w-3xl font-display text-4xl leading-[0.95] text-white md:text-7xl">
          Bind services you can explain, and results anyone can check.
        </h2>
        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-white/75 md:text-base">
          Write the problem once, run engines over it, and keep the composition that wins, with the
          evidence of why.
        </p>
        <div className="mt-10">
          {signedIn ? (
            <IslandButton label="Open your dashboard" to="/" />
          ) : (
            <IslandButton label="Start for free" to="/authentication?view=register" />
          )}
        </div>
      </section>
    </RevealBlock>
  );
}
