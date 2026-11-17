// Adapted from SPHERE frontend/src/modules/settings/components/NotificationsSection.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's kinds (invitations, system notices, composition updates, finished and failed runs) over
// `GET/PUT /v1/notifications/preferences`, written with `If-Match` and a 412 offered as a reload; each toggle is a labelled
// switch; loading and saving failures are said instead of logged. The inbox itself is `/notifications`.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FiInbox, FiLoader, FiMail } from 'react-icons/fi';
import { classifyAuthError } from '../../core/api/errors';
import BlockAlert from '../../core/components/block-alert';
import { offerReloadIfChanged } from '../../core/utils/offer-reload';
import { NOTIFICATION_KINDS } from '../../notification/api/notificationsApi';
import {
  useUserSettingsApi,
  type KindChannels,
  type NotificationPreferences,
} from '../api/userSettingsApi';
import { fallbackMessage } from '../../core/utils/account-errors';
import { useSavedFlash } from '../utils/useSavedFlash';
import SaveButton from './SaveButton';

type Kind = (typeof NOTIFICATION_KINDS)[number];

const KINDS: Record<Kind, { label: string; description: string }> = {
  OrganizationInvitation: {
    label: 'Organization invitations',
    description: 'When someone invites you to an organization',
  },
  System: {
    label: 'System notices',
    description: 'Important platform updates, plan changes and maintenance notices',
  },
  CompositionUpdated: {
    label: 'Composition updates',
    description: 'When a composition you follow gets a new version',
  },
  RunFinished: { label: 'Runs finished', description: 'When a run you launched finishes' },
  RunFailed: { label: 'Runs failed', description: 'When a run you launched fails' },
};

const CHANNELS = [
  { key: 'inbox' as const, label: 'In-App', icon: FiInbox },
  { key: 'email' as const, label: 'Email', icon: FiMail },
];

type Channel = (typeof CHANNELS)[number]['key'];
type Grid = Record<Kind, KindChannels>;

/** A kind with no saved preference is delivered on both channels, as the gateway does. */
function gridOf(preferences: NotificationPreferences): Grid {
  return Object.fromEntries(
    NOTIFICATION_KINDS.map(kind => {
      const saved = preferences.kinds?.[kind];
      return [kind, { inbox: saved?.inbox !== false, email: saved?.email !== false }];
    })
  ) as Grid;
}

interface Props {
  onDirtyChange?: (dirty: boolean) => void;
}

export default function NotificationsSection({ onDirtyChange }: Props) {
  const api = useUserSettingsApi();
  const [loaded, setLoaded] = useState<{ value: NotificationPreferences; etag: string | null }>();
  const [prefs, setPrefs] = useState<Grid | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, flash] = useSavedFlash();

  useEffect(() => {
    let current = true;
    api
      .getNotificationPreferences()
      .then(answer => {
        if (!current) return;
        setLoaded(answer);
        setPrefs(gridOf(answer.value));
        setLoadError(null);
      })
      .catch((caught: unknown) => {
        if (current) setLoadError(fallbackMessage(classifyAuthError(caught), 'loaded'));
      });
    return () => {
      current = false;
    };
  }, [api, attempt]);

  const reload = useCallback(() => {
    setLoadError(null);
    setPrefs(null);
    setAttempt(value => value + 1);
  }, []);

  const savedGrid = loaded ? gridOf(loaded.value) : null;
  const hasChanges =
    prefs !== null &&
    savedGrid !== null &&
    NOTIFICATION_KINDS.some(
      kind =>
        prefs[kind].email !== savedGrid[kind].email || prefs[kind].inbox !== savedGrid[kind].inbox
    );

  useEffect(() => {
    onDirtyChange?.(hasChanges);
  }, [hasChanges, onDirtyChange]);

  const toggleChannel = (kind: Kind, channel: Channel) => {
    setPrefs(previous =>
      previous
        ? { ...previous, [kind]: { ...previous[kind], [channel]: !previous[kind][channel] } }
        : previous
    );
  };

  const handleSave = async () => {
    if (!prefs || !loaded) return;
    setSaving(true);
    setSaveError(null);
    try {
      const answer = await api.updateNotificationPreferences(
        { ...loaded.value, kinds: prefs },
        loaded.etag
      );
      setLoaded(answer);
      setPrefs(gridOf(answer.value));
      flash();
    } catch (caught) {
      if (!offerReloadIfChanged(caught, { resource: 'your preferences', reload }))
        setSaveError(fallbackMessage(classifyAuthError(caught), 'saved'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-tp-ink">Notifications</h2>
        <p className="mt-0.5 text-sm text-tp-steel">
          Configure which notifications you receive and how. Everything sent to you is in your{' '}
          <Link to="/notifications" className="cursor-pointer text-tp-link hover:underline">
            inbox
          </Link>
          .
        </p>
      </div>

      {loadError && (
        <div>
          <BlockAlert
            variant="error"
            message={`Your preferences couldn’t be loaded. ${loadError}`}
          />
          <button
            type="button"
            onClick={reload}
            className="mt-3 cursor-pointer rounded-[8px] border border-tp-hairline-strong px-3.5 py-2 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface"
          >
            Try again
          </button>
        </div>
      )}

      {!loadError && !prefs && (
        <div
          className="flex items-center justify-center gap-2 rounded-[12px] border border-tp-hairline bg-tp-canvas px-6 py-12 text-sm text-tp-steel"
          aria-busy="true"
        >
          <FiLoader className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading preferences…
        </div>
      )}

      {prefs && (
        <>
          <div
            className="rounded-[12px] border border-tp-hairline bg-tp-canvas"
            role="group"
            aria-label="Notification channels"
          >
            <div className="grid grid-cols-[1fr_repeat(2,64px)] items-center gap-2 border-b border-tp-hairline px-4 py-3 sm:grid-cols-[1fr_repeat(2,80px)] sm:px-6">
              <span className="text-xs font-medium text-tp-steel">Notification type</span>
              {CHANNELS.map(channel => (
                <div key={channel.key} className="flex flex-col items-center gap-0.5">
                  <channel.icon className="h-4 w-4 text-tp-steel" aria-hidden="true" />
                  <span className="text-[10px] font-medium text-tp-steel">{channel.label}</span>
                </div>
              ))}
            </div>

            {NOTIFICATION_KINDS.map((kind, i) => (
              <div
                key={kind}
                className={`grid grid-cols-[1fr_repeat(2,64px)] items-center gap-2 px-4 py-4 transition-colors hover:bg-tp-surface sm:grid-cols-[1fr_repeat(2,80px)] sm:px-6 ${
                  i < NOTIFICATION_KINDS.length - 1 ? 'border-b border-tp-hairline' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-tp-ink">{KINDS[kind].label}</p>
                  <p className="text-xs text-tp-steel">{KINDS[kind].description}</p>
                </div>
                {CHANNELS.map(channel => {
                  const isOn = prefs[kind][channel.key];
                  return (
                    <div key={channel.key} className="flex justify-center">
                      <motion.button
                        whileTap={{ scale: 0.9 }}
                        type="button"
                        role="switch"
                        aria-checked={isOn}
                        aria-label={`${KINDS[kind].label}: ${channel.label}`}
                        onClick={() => toggleChannel(kind, channel.key)}
                        className={`relative h-6 w-11 cursor-pointer rounded-full transition-colors duration-200 ${
                          isOn ? 'bg-tp-primary' : 'bg-tp-hairline-strong'
                        }`}
                      >
                        <motion.span
                          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm"
                          animate={{ left: isOn ? 22 : 2 }}
                          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                        />
                      </motion.button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <BlockAlert variant="error" message={saveError} onDismiss={() => setSaveError(null)} />

          <div className="flex flex-wrap items-center gap-3">
            <SaveButton
              saving={saving}
              saved={saved}
              disabled={!hasChanges}
              label="Save preferences"
              onClick={() => void handleSave()}
            />
            {saved && (
              <motion.span
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                className="text-xs text-tp-accent"
                role="status"
              >
                Preferences updated
              </motion.span>
            )}
            {hasChanges && !saved && (
              <span className="text-xs text-tp-steel">You have unsaved changes</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
