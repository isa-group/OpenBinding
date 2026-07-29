import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PricingRenderer } from 'pricing-renderer/react';
import 'pricing-renderer/styles.css';
import { apiClient } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { Alert } from '../../components/ui/Alert';
import './Pricing.css';

/**
 * The plans, rendered from the same document the gateway enforces.
 *
 * The YAML is fetched from `GET /api/v1/schemas/pricing` rather than bundled,
 * so the page cannot drift from what SPACE was given: one document decides
 * what a solve is allowed to do and what this page says it is allowed to do.
 *
 * Rendering is `pricing-renderer`, which understands Pricing2Yaml properly -
 * billing periods, add-ons, plan comparison, formulas. Hand-rolling a
 * comparison table would mean re-deciding all of that, badly, and then
 * maintaining it every time the pricing gains a field.
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
        if (!cancelled) setError('The pricing could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="pricing-page">
      <div className="container">
        <div className="page-header">
          <h1>Plans</h1>
          <p className="page-description">
            Every account starts on Basic. Moving to Pro is done by an administrator: there is no
            payment gateway here.
          </p>
        </div>

        {error && <Alert type="error">{error}</Alert>}

        {yaml && (
          <PricingRenderer
            yaml={yaml}
            theme={theme}
            pricingPath="/pricing"
            onAction={(event: CustomEvent) => {
              // Nothing to check out. Whoever is interested either needs an
              // account first, or needs to ask an administrator.
              event.preventDefault();
              navigate(user ? '/account' : '/register');
            }}
          />
        )}

        <Alert type="info" title="What the limits mean">
          <p>
            An allowance that runs out refuses the request until it renews. A ceiling - the
            longest solver budget, the largest instance - reduces the request to what the plan
            allows instead, and says so alongside the result. The one exception is the size of an
            instance's binding space: there is no smaller version of an instance to solve, so
            that one is refused.
          </p>
        </Alert>
      </div>
    </div>
  );
}
