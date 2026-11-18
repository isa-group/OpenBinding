// Adapted from SPHERE frontend/src/modules/settings/components/BetaFeaturesSection.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the switch reads and writes OpenBinding's `GET/PUT /v1/users/me/settings/beta-features` (with `If-Match`, a 412
// offered as a reload) instead of SPHERE's settings blob in the session; failures are said with OpenBinding's wording; the
// note names OpenBinding's areas instead of ORBIT.

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { FiAlertTriangle, FiLoader } from 'react-icons/fi';
import { classifyAuthError } from '../../core/api/errors';
import BlockAlert from '../../core/components/block-alert';
import { offerReloadIfChanged } from '../../core/utils/offer-reload';
import BetaBadge from '../../beta/components/beta-badge';
import { BETA_FEATURES_CHANGED, useBetaFeatureList } from '../../beta/hooks/useBetaFeatures';
import { useUserSettingsApi } from '../api/userSettingsApi';
import { fallbackMessage } from '../../core/utils/account-errors';

export default function BetaFeaturesSection() {
  const api = useUserSettingsApi();
  const [state, setState] = useState<{ enabled: boolean; etag: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const features = useBetaFeatureList();

  useEffect(() => {
    let current = true;
    api
      .getBetaFeatures()
      .then(answer => {
        if (!current) return;
        setState({ enabled: answer.value.enabled === true, etag: answer.etag });
        // The beta tabs and gates of the other screens follow the switch at once.
        window.dispatchEvent(
          new CustomEvent(BETA_FEATURES_CHANGED, {
            detail: { enabled: answer.value.enabled === true },
          })
        );
        setError(null);
      })
      .catch((caught: unknown) => {
        if (current) setError(fallbackMessage(classifyAuthError(caught), 'loaded'));
      });
    return () => {
      current = false;
    };
  }, [api, attempt]);

  const reload = useCallback(() => {
    setState(null);
    setError(null);
    setAttempt(value => value + 1);
  }, []);

  const toggle = async () => {
    if (!state) return;
    setSaving(true);
    setError(null);
    try {
      const answer = await api.updateBetaFeatures(!state.enabled, state.etag);
      setState({ enabled: answer.value.enabled === true, etag: answer.etag });
      // The beta tabs and gates of the other screens follow the switch at once.
      window.dispatchEvent(
        new CustomEvent(BETA_FEATURES_CHANGED, {
          detail: { enabled: answer.value.enabled === true },
        })
      );
    } catch (caught) {
      if (!offerReloadIfChanged(caught, { resource: 'your settings', reload }))
        setError(fallbackMessage(classifyAuthError(caught), 'changed'));
    } finally {
      setSaving(false);
    }
  };

  const enabled = state?.enabled === true;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-medium text-tp-ink">
          Beta features <BetaBadge />
        </h2>
        <p className="mt-0.5 text-sm text-tp-steel">Try new functionality before it is finished</p>
      </div>

      <div className="rounded-[12px] border border-tp-hairline bg-tp-canvas">
        <div className="flex items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-sm font-medium text-tp-ink">Enable beta features</p>
            <p className="text-xs text-tp-steel">
              Show tabs, buttons and capabilities that are still being built
            </p>
          </div>
          <div className="flex items-center gap-3">
            {(saving || (!state && !error)) && (
              <FiLoader className="h-4 w-4 animate-spin text-tp-steel" aria-hidden="true" />
            )}
            <motion.button
              whileTap={{ scale: 0.9 }}
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Enable beta features"
              onClick={() => void toggle()}
              disabled={saving || !state}
              className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 disabled:cursor-not-allowed ${
                enabled ? 'bg-tp-primary' : 'bg-tp-hairline-strong'
              }`}
            >
              <motion.span
                className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm"
                animate={{ left: enabled ? 22 : 2 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              />
            </motion.button>
          </div>
        </div>

        <div className="flex items-start gap-3 border-t border-tp-hairline px-6 py-4">
          <FiAlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-tp-sunshine-800"
            aria-hidden="true"
          />
          <p className="text-xs text-tp-steel">
            Beta features may be incomplete, contain bugs, or change and disappear without notice.
            You can turn them off here at any time.
          </p>
        </div>
      </div>

      {error && (
        <div>
          <BlockAlert variant="error" message={error} />
          {!state && (
            <button
              type="button"
              onClick={reload}
              className="mt-3 cursor-pointer rounded-[8px] border border-tp-hairline-strong px-3.5 py-2 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface"
            >
              Try again
            </button>
          )}
        </div>
      )}

      <div>
        <h3 className="text-sm font-medium text-tp-ink">Available right now</h3>
        {features.length === 0 ? (
          <p className="mt-2 rounded-[12px] border border-dashed border-tp-hairline px-6 py-5 text-sm text-tp-steel">
            There are no beta features at the moment. New ones will show up here.
          </p>
        ) : (
          <ul className="mt-2 rounded-[12px] border border-tp-hairline bg-tp-canvas">
            {features.map(([key, feature], i) => (
              <li
                key={key}
                className={`px-6 py-4 ${i < features.length - 1 ? 'border-b border-tp-hairline' : ''}`}
              >
                <p className="text-sm font-medium text-tp-ink">
                  {feature.name}{' '}
                  <span className="text-xs font-normal text-tp-steel">· {feature.area}</span>
                </p>
                <p className="text-xs text-tp-steel">{feature.description}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
