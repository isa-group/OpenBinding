import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PricingRenderer } from 'pricing-renderer/react';
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
 * Rendering is `pricing-renderer`, which understands Pricing2Yaml properly -
 * billing periods, add-ons, plan comparison, formulas, tags. Hand-rolling a
 * comparison table would mean re-deciding all of that, badly, and then
 * maintaining it every time the pricing gains a field. What this page adds
 * around it is the part a table of numbers cannot say: what actually happens
 * when you reach one of these limits.
 */
export function Pricing() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [yaml, setYaml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getPricingDocument()
      .then((document) => {
        if (!cancelled) setYaml(document);
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
            Every account starts free, with an allowance that renews each month. Pro raises
            every ceiling for research workloads. There is no payment gateway here: an
            administrator moves an account between plans.
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
                <Link to="/register" viewTransition>Create an account</Link> to start on Free, or{' '}
                <Link to="/playground" viewTransition>try the playground</Link> without one.
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

        <section className="pricing-behaviour">
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
            rather than by the gateway itself, from the same pricing this page renders.
          </p>
        </section>
      </div>
    </div>
  );
}
