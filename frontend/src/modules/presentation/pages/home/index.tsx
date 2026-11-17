// Adapted from SPHERE frontend/src/modules/presentation/pages/home/index.tsx and components/hero-section.tsx (revision
// 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's landing in SPHERE's sections: the hero ("Describe. Bind. Reproduce.") with its island buttons,
// the runtime catalogue status, the pipeline as tabs, the public engines, the plans and the layers of BIM, each revealed
// on scroll, then the call to action. The page sits in the session's layout (SPHERE's floating header for visitors), so
// it draws no header or footer of its own; the theme's tokens and display font replace SPHERE's hex values and the
// fonts it loads inline; links instead of `router.push` buttons.

import { useRef, useState, type KeyboardEvent } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { PRICING_VERSION, planSummaries } from '../../../../content/plans';
import { useResource } from '../../../core/hooks/useResource';
import { useAuth } from '../../../auth/hooks/useAuth';
import BackgroundOrbs from './components/background-orbs';
import CallToAction from './components/call-to-action';
import IslandButton from './components/island-button';
import RevealBlock from './components/reveal-block';
import { LAYERS, PIPELINE } from './data';
import { engineClient } from '../../../engine/api/engineClient';

function Eyebrow({ children }: { children: string }) {
  return (
    <span className="inline-flex rounded-full border border-black/10 bg-white/70 px-3 py-1 text-[10px] font-medium tracking-[0.22em] text-tp-slate uppercase">
      {children}
    </span>
  );
}

function SectionHead({
  eyebrow,
  title,
  id,
  link,
}: {
  eyebrow: string;
  title: string;
  id: string;
  link?: { to: string; label: string };
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 id={id} className="mt-4 font-display text-3xl leading-tight text-tp-ink md:text-5xl">
          {title}
        </h2>
      </div>
      {link && (
        <Link to={link.to} className="text-sm font-medium text-tp-accent hover:underline">
          {link.label}
        </Link>
      )}
    </div>
  );
}

function RuntimeStatus({ signedIn }: { signedIn: boolean }) {
  const runtime = useResource(`landing-runtime:${signedIn}`, async () => {
    const [profiles, engines] = await Promise.all([
      engineClient.getProtocolProfiles(),
      // The full catalogue is for accounts; visitors get the public one.
      signedIn ? engineClient.getEngines() : engineClient.getPublicEngines(),
    ]);
    return { profiles: profiles.length, engines: engines.length };
  });
  const counts = runtime.data;
  return (
    <div
      role="status"
      aria-label="Runtime catalogue status"
      className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-tp-steel"
    >
      {counts ? (
        <>
          <span className="inline-flex items-center gap-1.5 text-emerald-700">
            <i className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" /> Runtime
            catalogue connected
          </span>
          <span>
            {counts.profiles} executable profile{counts.profiles === 1 ? '' : 's'}
          </span>
          <span>
            {counts.engines} {signedIn ? '' : 'public '}engine revision
            {counts.engines === 1 ? '' : 's'}
          </span>
        </>
      ) : runtime.status === 'error' ? (
        <span className="inline-flex items-center gap-1.5 text-red-700">
          <i className="h-2 w-2 rounded-full bg-red-500" aria-hidden="true" /> Runtime catalogue
          unavailable
        </span>
      ) : (
        <span>Checking the runtime catalogue…</span>
      )}
    </div>
  );
}

function Pipeline() {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const stage = PIPELINE[active];

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const target: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: PIPELINE.length - 1,
    };
    if (!(event.key in target)) return;
    event.preventDefault();
    const next = (target[event.key] + PIPELINE.length) % PIPELINE.length;
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <section aria-labelledby="landing-pipeline-title" className="mt-24">
      <RevealBlock>
        <SectionHead
          eyebrow="How it works"
          title="From a problem to a composition anyone can verify"
          id="landing-pipeline-title"
        />
        <div
          role="tablist"
          aria-label="Pipeline stages"
          className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7"
        >
          {PIPELINE.map((item, index) => (
            <button
              key={item.id}
              ref={node => {
                tabs.current[index] = node;
              }}
              id={`landing-stage-${item.id}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              aria-controls="landing-stage-panel"
              tabIndex={index === active ? 0 : -1}
              onClick={() => setActive(index)}
              onKeyDown={event => onKeyDown(event, index)}
              className={`flex cursor-pointer flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors ${
                index === active
                  ? 'border-tp-primary bg-tp-canvas shadow-elevation-2'
                  : 'border-tp-hairline bg-white/60 hover:bg-tp-canvas'
              }`}
            >
              <span className="font-mono text-[11px] text-tp-steel">{item.step}</span>
              <strong className="text-sm text-tp-ink">{item.title}</strong>
              <span className="text-xs text-tp-steel">{item.short}</span>
            </button>
          ))}
        </div>
        <div
          id="landing-stage-panel"
          role="tabpanel"
          aria-labelledby={`landing-stage-${stage.id}`}
          aria-live="polite"
          className="mt-4 flex flex-col gap-4 rounded-2xl border border-tp-hairline bg-tp-canvas p-6 md:flex-row md:items-center md:justify-between"
        >
          <div className="max-w-3xl">
            <span className="text-xs font-semibold tracking-[0.16em] text-tp-accent uppercase">
              {stage.step} · {stage.title}
            </span>
            <p className="mt-2 text-sm leading-relaxed text-tp-slate">{stage.long}</p>
            <code className="mt-3 inline-block rounded bg-tp-surface px-2 py-1 font-mono text-xs text-tp-ink">
              {stage.pin}
            </code>
          </div>
          <Link
            to={stage.href}
            className="shrink-0 rounded-full bg-tp-ink px-5 py-2.5 text-sm font-medium text-white hover:bg-tp-ink/90"
          >
            {stage.cta}
          </Link>
        </div>
      </RevealBlock>
    </section>
  );
}

function PublicEngines() {
  const engines = useResource('landing-engines', () => engineClient.getPublicEngines());
  const engineList = engines.data ?? [];
  const names = [...new Set(engineList.map(engine => engine.name))];
  return (
    <section aria-labelledby="landing-engines-title" className="mt-24">
      <RevealBlock>
        <SectionHead
          eyebrow="Public engines"
          title="Engines anyone can run"
          id="landing-engines-title"
          link={{ to: '/engines', label: 'All engines' }}
        />
        <div aria-live="polite" aria-busy={engines.status === 'loading'}>
          {engines.status === 'loading' && (
            <p className="text-sm text-tp-steel">Loading the public engines…</p>
          )}
          {engines.status === 'error' && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              The public engines couldn’t be loaded. The rest of the page still works.
              <button
                type="button"
                onClick={engines.reload}
                className="cursor-pointer font-medium underline"
              >
                Retry
              </button>
            </div>
          )}
          {engines.status === 'ready' && engineList.length === 0 && (
            <p className="rounded-xl border border-dashed border-tp-hairline-strong p-6 text-sm text-tp-steel">
              No public engines yet. An engine appears here once it is published.
            </p>
          )}
          {engines.status === 'ready' && engineList.length > 0 && (
            <Link
              to="/engines"
              className="block rounded-2xl border border-tp-hairline bg-tp-canvas p-6 transition-shadow hover:shadow-elevation-2"
            >
              <strong className="block text-xl text-tp-ink">
                {engineList.length} public engine revision{engineList.length === 1 ? '' : 's'}
              </strong>
              <span className="mt-1 block font-mono text-sm text-tp-steel">
                {names.join(' · ')}
              </span>
            </Link>
          )}
        </div>
      </RevealBlock>
    </section>
  );
}

function Plans() {
  return (
    <section aria-labelledby="landing-plans-title" className="mt-24">
      <RevealBlock>
        <SectionHead
          eyebrow="Plans"
          title="Free to start, institutional when you scale"
          id="landing-plans-title"
          link={{ to: '/pricing', label: 'Compare plans' }}
        />
        <ul className="grid gap-4 md:grid-cols-3">
          {planSummaries.map(plan => (
            <li
              key={plan.name}
              className="flex flex-col gap-2 rounded-2xl border border-tp-hairline bg-tp-canvas p-6"
            >
              <span className="text-xs font-semibold tracking-[0.16em] text-tp-accent uppercase">
                {plan.name}
              </span>
              <strong className="text-2xl text-tp-ink">{plan.price}</strong>
              <span className="text-sm text-tp-slate">{plan.how}</span>
              <span className="mt-2 flex flex-wrap gap-1.5">
                {plan.chips.map(chip => (
                  <span
                    key={chip}
                    className="rounded-full bg-tp-surface px-2 py-0.5 text-[11px] text-tp-steel"
                  >
                    {chip}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-tp-steel">
          Headline limits from pricing {PRICING_VERSION}; the Pricing page shows the live document.
          No checkout: paid plans are arranged by agreement.
        </p>
      </RevealBlock>
    </section>
  );
}

function Layers() {
  return (
    <section aria-labelledby="landing-layers-title" className="mt-24">
      <RevealBlock>
        <SectionHead
          eyebrow="Extensibility is the architecture"
          title="A stable core, plural problem families."
          id="landing-layers-title"
        />
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {LAYERS.map(layer => (
            <li key={layer.id} className="rounded-2xl border border-tp-hairline bg-tp-canvas p-6">
              <span className="text-xs font-semibold tracking-[0.16em] text-tp-accent uppercase">
                {layer.label}
              </span>
              <strong className="mt-2 block text-lg text-tp-ink">{layer.title}</strong>
              <p className="mt-2 text-sm text-tp-slate">{layer.copy}</p>
              {layer.note && <p className="mt-2 text-xs text-tp-steel">{layer.note}</p>}
            </li>
          ))}
        </ul>
      </RevealBlock>
    </section>
  );
}

export default function HomePage() {
  const { user } = useAuth();
  const signedIn = Boolean(user);

  return (
    <>
      <Helmet>
        <title>OpenBinding - Describe. Bind. Reproduce.</title>
        <meta
          name="description"
          content="OpenBinding defines, versions, evaluates and compares service compositions, and binds them by solving BIM problems."
        />
      </Helmet>
      <div className="relative overflow-x-clip bg-tp-cream-light text-tp-ink">
        <BackgroundOrbs />
        <div className="relative z-[3] mx-auto flex w-full max-w-[1240px] flex-col px-4 pt-16 pb-24 md:px-8 md:pt-24 md:pb-32">
          {/* Hero */}
          <section aria-labelledby="landing-hero-title" className="py-12 md:py-20">
            <RevealBlock className="mb-8">
              <Eyebrow>Compositions · Composition2Yaml · BIM problems</Eyebrow>
            </RevealBlock>
            <RevealBlock className="max-w-4xl" delay={120}>
              <h1
                id="landing-hero-title"
                className="font-display text-[2.6rem] leading-[0.95] font-semibold text-tp-ink md:text-[4.9rem] lg:text-[5.8rem]"
              >
                <span className="block">Describe.</span>{' '}
                <span className="block text-tp-slate">Bind.</span>{' '}
                <span className="animate-hero-gradient block w-fit bg-linear-to-r from-tp-ink via-tp-primary to-emerald-600 bg-[length:200%_200%] bg-clip-text text-transparent">
                  Reproduce.
                </span>
              </h1>
            </RevealBlock>
            <RevealBlock className="mt-8 max-w-2xl" delay={220}>
              <p className="text-base leading-relaxed text-tp-slate md:text-lg">
                Define, version, evaluate, render and compare compositions; problems, written in
                BIM, say what was possible. OpenBinding compiles a problem, runs engines over it and
                re-evaluates every binding they return, so a composition’s values can be verified
                against the problem it links.
              </p>
            </RevealBlock>
            <RevealBlock className="mt-10 flex flex-wrap items-center gap-4" delay={300}>
              {signedIn ? (
                <IslandButton label="Open your dashboard" to="/" />
              ) : (
                <IslandButton label="Create an account" to="/authentication?view=register" />
              )}
              <IslandButton label="Explore compositions" to="/compositions" outlined />
              <IslandButton label="Learn Composition2Yaml" to="/language" outlined />
            </RevealBlock>
            <RuntimeStatus signedIn={signedIn} />
          </section>

          <Pipeline />
          <PublicEngines />
          <Plans />
          <Layers />
          <CallToAction signedIn={signedIn} />
        </div>
      </div>
    </>
  );
}
