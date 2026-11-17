// Adapted from SPHERE frontend/src/modules/presentation/pages/home/components/background-orbs.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the theme's colours (the brand's primary, Tailwind's blue and amber) instead of SPHERE's hex values.

export default function BackgroundOrbs() {
  return (
    <div aria-hidden="true">
      <div className="pointer-events-none fixed inset-0 z-[1] [background-image:radial-gradient(circle_at_1px_1px,rgba(15,23,42,0.9)_1px,transparent_0)] [background-size:4px_4px] opacity-[0.025]" />
      <div className="pointer-events-none absolute inset-0 z-[2] overflow-hidden">
        <div className="absolute top-[10%] -left-28 h-[28rem] w-[28rem] rounded-full bg-emerald-100 blur-[140px]" />
        <div className="absolute top-[20%] right-[-8rem] h-[34rem] w-[34rem] rounded-full bg-blue-100 blur-[160px]" />
        <div className="absolute bottom-[-11rem] left-[35%] h-[24rem] w-[24rem] rounded-full bg-tp-primary/15 blur-[140px]" />
      </div>
    </div>
  );
}
