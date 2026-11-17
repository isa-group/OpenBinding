// Adapted from SPHERE frontend/src/modules/presentation/pages/changelog/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the tabs are OpenBinding (the platform and its documentation) and Language (BIM and its engines), fed by
// `content/changelog.json`; the tab is in the address (`?tab=`) and the tabs are announced as such; a heading and lede, the
// page within the site's width and gutters (SPHERE's `px-16` overflowed a phone); an empty state for a tab with no release.

import { motion } from 'framer-motion';
import { Helmet } from 'react-helmet-async';
import { useSearchParams } from 'react-router-dom';
import changelogJson from '../../../../content/changelog.json';
import PendingReview from '../../components/pending-review';
import Changelog from './components/changelog';
import { CHANGELOG_TABS, changelogEntries, parseChangelogTab } from './changelog-model';
import type { ChangelogData } from './types';

export default function ChangelogPage({
  changelog = changelogJson,
}: {
  changelog?: ChangelogData;
}) {
  const [params, setParams] = useSearchParams();
  const currentTab = parseChangelogTab(params.get('tab'));
  const active = CHANGELOG_TABS.find(tab => tab.id === currentTab) ?? CHANGELOG_TABS[0];
  const releases = changelogEntries(changelog, active.streams);

  return (
    <>
      <Helmet>
        <title>OpenBinding - Changelog</title>
      </Helmet>
      <section className="mx-auto w-full max-w-7xl px-4 pt-8 pb-4 sm:px-6 lg:px-8">
        <h1 className="font-display text-4xl text-tp-ink">Changelog</h1>
        <p className="mt-2 mb-8 max-w-3xl text-tp-slate">
          What changed in each release of the platform and of the language. This page is reviewed as
          data in the repository, not served by the API.
        </p>
        <nav
          role="tablist"
          aria-label="Changelog"
          className="mb-6 flex gap-1 overflow-x-auto border-b border-tp-hairline"
        >
          {CHANGELOG_TABS.map(changelogTab => {
            const selected = currentTab === changelogTab.id;
            return (
              <button
                key={changelogTab.id}
                type="button"
                role="tab"
                id={`changelog-tab-${changelogTab.id}`}
                aria-selected={selected}
                aria-controls="changelog-panel"
                onClick={() =>
                  setParams(changelogTab.id === 'openbinding' ? {} : { tab: changelogTab.id }, {
                    replace: true,
                  })
                }
                className={`relative cursor-pointer px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${selected ? 'text-tp-accent' : 'text-tp-steel hover:text-tp-ink'}`}
              >
                {changelogTab.label}
                {selected && (
                  <motion.div
                    layoutId="changelog-tab"
                    className="absolute right-0 bottom-0 left-0 h-0.5 bg-tp-primary"
                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                  />
                )}
              </button>
            );
          })}
        </nav>

        <div id="changelog-panel" role="tabpanel" aria-labelledby={`changelog-tab-${currentTab}`}>
          {releases.length > 0 ? (
            <Changelog releases={releases} />
          ) : (
            <PendingReview what={active.label} />
          )}
        </div>
      </section>
    </>
  );
}
