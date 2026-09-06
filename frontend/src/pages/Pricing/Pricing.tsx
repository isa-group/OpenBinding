import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PricingRenderer } from 'pricing-renderer/react';
import { Default, ErrorFallback, Feature, Loading, On, feature } from 'pricing4react';
import { retrievePricingFromYaml } from 'pricing4ts';
import type { Pricing as PricingModel } from 'pricing4ts';
import 'pricing-renderer/styles.css';
import { apiClient } from '../../api/client';
import { useAuth } from '../../contexts/auth';
import { useTheme } from '../../contexts/theme';
import { Alert } from '../../components/ui/Alert';
import './Pricing.css';

/**
 * The plans, rendered from the same document the gateway serves and SPACE
 * enforces.
 *
 * The YAML is fetched from `GET /v1/pricing` rather than bundled,
 * so this page cannot drift from what is actually being charged: one document
 * decides what a solve may do and what this page says it may do.
 *
 * `pricing4ts` parses the active document and `pricing-renderer` projects it.
 * `pricing4react` reads the signed SPACE token for visual state only; the API
 * independently enforces every operation.
 */
export function Pricing() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [yaml, setYaml] = useState<string | null>(null);
  const [pricing, setPricing] = useState<PricingModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getPricingDocument()
      .then((document) => {
        const parsed = retrievePricingFromYaml(document);
        if (!cancelled) {
          setYaml(document);
          setPricing(parsed);
        }
      })
      .catch(() => {
        if (!cancelled) setError('The plans could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="pricing-page">
      <div className="container">
        <header className="pricing-hero">
          <span className="pricing-eyebrow">Pricing</span>
          <h1>Solve as much as you need to</h1>
          <p>
            Plans, add-ons, features, limits, prices and selection rules below come directly
            from the active iPricing. There is no second catalog embedded in this interface.
          </p>

          {user ? (
            <div className="pricing-standing">
              <span className="pricing-eyebrow">{user.plan}</span>
              <span>
                You are on this plan. <Link to="/account" viewTransition>See what is left of it</Link>.
              </span>
            </div>
          ) : (
            <div className="pricing-standing">
              <span>
                <Link to="/register" viewTransition>Create an account</Link> on the free plan, or{' '}
                <Link to="/login" viewTransition>sign in</Link> to inspect your current access.
              </span>
            </div>
          )}
        </header>

        {error && <Alert type="error">{error}</Alert>}

        <div className="pricing-renderer-shell">
          {yaml ? (
            <PricingRenderer
              yaml={yaml}
              theme={theme}
              pricingPath="/pricing"
              onAction={(event: CustomEvent) => {
                // Nothing to check out. Whoever is interested either needs an
                // account first, or needs to ask an administrator.
                event.preventDefault();
                navigate(user ? '/account' : '/register', { viewTransition: true });
              }}
            />
          ) : (
            !error && <div className="pricing-loading">Loading the plans…</div>
          )}
        </div>

        {user && pricing && (
          <section className="pricing-entitlements" aria-labelledby="current-feature-access">
            <header>
              <span className="pricing-eyebrow">Signed feature state</span>
              <h2 id="current-feature-access">Available to your account</h2>
              <p>Visual state comes from your SPACE pricing token for this exact configuration.</p>
            </header>
            <div>
              {Object.entries(pricing.features).map(([id, item]) => (
                <article key={id}>
                  <span>{item.tag ?? item.type}</span>
                  <strong>{item.name}</strong>
                  {item.description && <p>{item.description}</p>}
                  <Feature expression={feature(`${pricing.saasName.toLowerCase()}-${id}`)}>
                    <On><small className="is-enabled">Enabled</small></On>
                    <Default><small>Not enabled</small></Default>
                    <Loading><small aria-live="polite">Checking…</small></Loading>
                    <ErrorFallback><small>Unavailable</small></ErrorFallback>
                  </Feature>
                </article>
              ))}
            </div>
          </section>
        )}

        <section className="pricing-behaviour">
          {pricing?.plans?.RESEARCH && <div className="research-access-note">
            <img src="/brands/universidad-sevilla.svg" alt="Universidad de Sevilla" />
            <div><span>Institutional access</span><h2>RESEARCH, verified at sign-in</h2><p>{pricing.plans.RESEARCH.description}</p></div>
          </div>}
          <h2>What happens when you reach a limit</h2>
          <p>
            Three things, and which one depends on whether the limit is something you asked
            for or something about the work itself.
          </p>

          <div className="pricing-outcomes">
            <article className="pricing-outcome pricing-outcome-reduce">
              <span className="pricing-outcome-mark" aria-hidden="true">
                ≤
              </span>
              <h3>A budget is reduced</h3>
              <p>
                Ask for a longer solve or more search effort than your plan allows and you get
                the allowed amount, not a refusal. The reduction comes back with the result as
                an <code>OPTION_CLAMPED</code> warning, so a shorter answer is never a silent
                one.
              </p>
            </article>

            <article className="pricing-outcome pricing-outcome-wait">
              <span className="pricing-outcome-mark" aria-hidden="true">
                ↻
              </span>
              <h3>An allowance runs out</h3>
              <p>
                Monthly solver time and job counts refuse further work until they renew, with
                the date they renew on. Concurrency is the same idea over a shorter horizon: a
                slot frees the moment a job finishes.
              </p>
            </article>

            <article className="pricing-outcome pricing-outcome-refuse">
              <span className="pricing-outcome-mark" aria-hidden="true">
                ×
              </span>
              <h3>An instance is too large</h3>
              <p>
                Instance complexity is a fact about the submitted resources, and there is no
                smaller version to run instead. Requests beyond the configured ceiling are refused
                rather than trimmed, and the refusal tells you the size it measured.
              </p>
            </article>
          </div>

          <p className="pricing-footnote">
            These plans are enforced by{' '}
            <a href="https://github.com/isa-group/space" target="_blank" rel="noopener noreferrer">
              SPACE
            </a>{' '}
            rather than by the gateway itself, from the same immutable SPHERE pricing this page renders.
            Add-on availability and subscription constraints are read from that document as well.
          </p>
        </section>
      </div>
    </div>
  );
}
