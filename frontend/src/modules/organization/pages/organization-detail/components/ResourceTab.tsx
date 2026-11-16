// The resource tabs of the organization page (Compositions, Problems, Runs, Studies), after the panel of SPHERE
// frontend/src/modules/organization/pages/organization-detail/components/PricingsTab.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in
// THIRD_PARTY_NOTICES.md. Pattern only: until the composition list (PR-C) and the problem, run and study lists (PR-D) are
// poured into SPHERE's list view, each tab shows the latest compositions or the count, and leads to the screen that holds
// them; a non-member sees the public compositions, each on its public page.

import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../../../auth/hooks/useAuth';
import { readResponse } from '../../../../core/api/http';
import type { CompositionList } from '../../../../core/api/types';
import Iconify from '../../../../core/components/iconify';
import { transitionDefault } from '../../../../core/utils/motion-variants';
import {
  compositionPath,
  compositionsPath,
  showcasePath,
} from '../../../../../routes/paths/compositions';
import { problemsPath } from '../../../../../routes/paths/problems';
import { launchPath, runsPath } from '../../../../../routes/paths/runs';
import { newStudyPath, studiesPath } from '../../../../../routes/paths/studies';
import type { OrganizationStats, OrgRole } from '../../../api/organizationsApi';

type Kind = 'compositions' | 'problems' | 'runs' | 'studies';

interface Props {
  kind: Kind;
  org: { slug: string; name: string; stats?: OrganizationStats | null };
  myRole: OrgRole | null;
  isPublicView?: boolean;
}

const COPY: Record<
  Kind,
  { title: string; lede: string; open: string; create: string; icon: string }
> = {
  compositions: {
    title: 'Compositions',
    lede: 'The service compositions this organization keeps, with their versions.',
    open: 'Open all compositions',
    create: 'New composition',
    icon: 'mdi:tag-outline',
  },
  problems: {
    title: 'Problems',
    lede: 'The binding problems of this organization: BIM packages and their revisions.',
    open: 'Open the problems',
    create: 'New problem',
    icon: 'mdi:file-tree-outline',
  },
  runs: {
    title: 'Runs',
    lede: 'Every engine run launched in this organization.',
    open: 'Open the runs',
    create: 'Start a run',
    icon: 'mdi:play-circle-outline',
  },
  studies: {
    title: 'Studies',
    lede: 'Engine comparisons over problems, parameters and seeds.',
    open: 'Open the studies',
    create: 'New study',
    icon: 'mdi:chart-box-outline',
  },
};

const SHOWN = 6;

function targets(kind: Kind, slug: string): { open: string; create: string } {
  switch (kind) {
    case 'compositions':
      return {
        open: compositionsPath(slug),
        create: `${compositionsPath(slug)}?create=composition`,
      };
    case 'problems':
      return { open: problemsPath(slug), create: `${problemsPath(slug)}?create=problem` };
    case 'runs':
      return { open: runsPath(slug), create: launchPath(slug) };
    case 'studies':
      return { open: studiesPath(slug), create: newStudyPath(slug) };
  }
}

export default function ResourceTab({ kind, org, myRole, isPublicView = false }: Props) {
  const { fetchWithInterceptor } = useAuth();
  const [compositions, setCompositions] = useState<CompositionList['compositions'] | null>(null);
  const [failed, setFailed] = useState(false);
  const copy = COPY[kind];
  const links = targets(kind, org.slug);
  const canCreate =
    !isPublicView && (myRole === 'OWNER' || myRole === 'ADMIN' || myRole === 'MEMBER');
  const count = org.stats ? org.stats[kind] : null;

  useEffect(() => {
    if (kind !== 'compositions') return;
    const controller = new AbortController();
    fetchWithInterceptor(
      `/v1/organizations/${encodeURIComponent(org.slug)}/compositions?sort=updated&limit=${SHOWN}&archived=false`,
      { signal: controller.signal }
    )
      .then(response => readResponse<CompositionList>(response))
      .then(list => setCompositions(list.compositions))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [kind, org.slug, fetchWithInterceptor]);

  return (
    <motion.section
      key={kind}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={transitionDefault}
      aria-label={copy.title}
      className="rounded-xl border border-tp-hairline bg-tp-canvas"
    >
      <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg text-tp-ink">
            {isPublicView ? 'Public compositions' : copy.title}
            {count !== null && <span className="ml-2 text-sm text-tp-steel">{count}</span>}
          </h2>
          <p className="text-xs text-tp-steel">
            {isPublicView ? 'The compositions this organization publishes.' : copy.lede}
          </p>
        </div>
        {!isPublicView && (
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={links.open}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-tp-hairline-strong bg-tp-canvas px-3 py-2 text-sm font-medium text-tp-ink transition-colors hover:border-tp-accent hover:text-tp-accent"
            >
              {copy.open}
            </Link>
            {canCreate && (
              <Link
                to={links.create}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-tp-accent px-3 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep"
              >
                <Iconify icon="mdi:plus" width={16} />
                {copy.create}
              </Link>
            )}
          </div>
        )}
      </div>

      {kind === 'compositions' ? (
        <div className="divide-y divide-tp-hairline">
          {failed && (
            <p role="alert" className="px-5 py-6 text-sm text-red-700">
              The compositions could not be loaded.
            </p>
          )}
          {!failed && compositions === null && (
            <p className="px-5 py-6 text-sm text-tp-steel">Loading compositions…</p>
          )}
          {compositions?.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-tp-ink">
              <Iconify icon={copy.icon} width={32} />
              <p className="text-sm">No compositions yet.</p>
            </div>
          )}
          {compositions?.map(composition => (
            <Link
              key={composition.id}
              to={
                isPublicView
                  ? showcasePath(org.slug, composition.slug)
                  : compositionPath(org.slug, composition.slug)
              }
              className="flex flex-wrap items-center gap-3 px-5 py-3 transition-colors hover:bg-tp-surface/50"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-tp-ink">
                  {composition.name}
                </span>
                <span className="block truncate text-[11px] text-tp-steel">
                  @{composition.slug} · {composition.kind} · {composition.version_count} versions
                </span>
              </span>
              {!isPublicView && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    composition.visibility === 'public'
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-tp-surface text-tp-steel'
                  }`}
                >
                  {composition.visibility === 'public' ? 'Public' : 'Private'}
                </span>
              )}
              <Iconify icon="mdi:chevron-right" width={16} className="text-tp-muted" />
            </Link>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-tp-cream text-tp-accent">
            <Iconify icon={copy.icon} width={24} />
          </span>
          <p className="text-sm text-tp-steel">
            {count === null
              ? `The ${copy.title.toLowerCase()} of ${org.name}.`
              : `${count} ${count === 1 ? copy.title.toLowerCase().replace(/s$/, '') : copy.title.toLowerCase()} in ${org.name}.`}
          </p>
          <Link to={links.open} className="text-sm font-medium text-tp-accent underline">
            {copy.open}
          </Link>
        </div>
      )}
    </motion.section>
  );
}
