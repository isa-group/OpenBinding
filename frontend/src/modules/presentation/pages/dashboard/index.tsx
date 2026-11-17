// Adapted from SPHERE frontend/src/modules/presentation/pages/dashboard/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's workspace: the stat tiles count organizations, the compositions the account reads and the runs
// running; recent organizations, compositions and problems (recents the account can still read, else the latest
// compositions), then the recent runs of the organizations; OpenBinding's quick actions; the empty state for an account
// without organizations, with the invitation hint; the plan-changed notice; links instead of `router.push` buttons; the
// greeting uses the username (OpenBinding keeps no first name).

import { motion } from 'framer-motion';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import type { Job } from '../../../../api/platform';
import { runsApi } from '../../../../api/runs';
import { PlanChangedNotice } from '../../../../components/PlanChangedNotice/PlanChangedNotice';
import {
  compositionPath,
  myCompositionsPath,
  publicCompositionsPath,
} from '../../../../routes/paths/compositions';
import { problemPath } from '../../../../routes/paths/problems';
import { launchPath, runPath } from '../../../../routes/paths/runs';
import { useAuth } from '../../../auth/hooks/useAuth';
import { readResponse } from '../../../core/api/http';
import type { CompositionList } from '../../../core/api/types';
import Iconify from '../../../core/components/iconify';
import DashboardSkeleton from '../../../core/components/skeletons/dashboard-skeleton';
import { useRecentItems } from '../../../core/hooks/useRecentItems';
import { fadeInUp, staggerContainer, transitionDefault } from '../../../core/utils/motion-variants';
import OrganizationCard from '../../../organization/components/organization-card';
import { useOrganization } from '../../../organization/hooks/useOrganization';

const RECENT_LIMIT = 3;
const RUNS_SHOWN = 5;

type Composition = CompositionList['compositions'][number];

function Section({
  title,
  viewAll,
  delay,
  children,
}: {
  title: string;
  viewAll?: string;
  delay: number;
  children: ReactNode;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...transitionDefault, delay }}
      aria-label={title}
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-tp-ink">{title}</h2>
        {viewAll && (
          <Link to={viewAll} className="cursor-pointer text-xs text-tp-accent hover:underline">
            View all
          </Link>
        )}
      </div>
      {children}
    </motion.section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-6 text-center text-sm text-tp-steel">
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const { user, fetchWithInterceptor } = useAuth();
  const { organizations, isLoading: organizationsLoading } = useOrganization();
  const { recentOrganizations, recentCompositions, recentProblems } = useRecentItems();
  const [compositions, setCompositions] = useState<Composition[]>([]);
  const [compositionsTotal, setCompositionsTotal] = useState(0);
  const [runs, setRuns] = useState<Array<Job & { orgSlug: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);

  const orgKey = organizations.map(org => org.slug).join(',');
  useEffect(() => {
    if (organizationsLoading) return;
    const slugs = orgKey ? orgKey.split(',').slice(0, RECENT_LIMIT) : [];
    let current = true;
    Promise.all([
      fetchWithInterceptor('/v1/users/me/compositions?sort=updated&limit=12')
        .then(response => readResponse<CompositionList>(response))
        .catch(
          () => ({ compositions: [], total: 0 }) as Pick<CompositionList, 'compositions' | 'total'>
        ),
      Promise.all(
        slugs.map(slug =>
          runsApi
            .list(slug, { limit: RUNS_SHOWN })
            .then(list => list.runs.map(run => ({ ...run, orgSlug: slug })))
            .catch(() => [])
        )
      ),
    ]).then(([compositionList, runLists]) => {
      if (!current) return;
      setCompositions(compositionList.compositions ?? []);
      setCompositionsTotal(compositionList.total ?? 0);
      setRuns(
        runLists
          .flat()
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
          .slice(0, RUNS_SHOWN)
      );
      setIsLoading(false);
    });
    return () => {
      current = false;
    };
  }, [orgKey, organizationsLoading, fetchWithInterceptor]);

  const bySlug = useMemo(() => new Map(organizations.map(org => [org.slug, org])), [organizations]);
  const byId = useMemo(() => new Map(organizations.map(org => [org.id, org])), [organizations]);

  // Recents the account can still read, else the first organizations of its tree.
  const recentOrgs = useMemo(() => {
    const recents = recentOrganizations
      .map(item => bySlug.get(item.id) ?? byId.get(item.orgId))
      .filter((org): org is (typeof organizations)[number] => Boolean(org));
    return (recents.length > 0 ? recents : organizations).slice(0, RECENT_LIMIT);
  }, [recentOrganizations, bySlug, byId, organizations]);

  const recentComps = useMemo(() => {
    const readable = new Map(compositions.map(c => [`${c.organization.slug}/${c.slug}`, c]));
    const recents = recentCompositions
      .map(item => readable.get(item.id))
      .filter((c): c is Composition => Boolean(c));
    return (recents.length > 0 ? recents : compositions).slice(0, RECENT_LIMIT);
  }, [recentCompositions, compositions]);

  const recentProbs = useMemo(
    () =>
      recentProblems
        .filter(item => bySlug.has(item.orgId) || byId.has(item.orgId))
        .slice(0, RECENT_LIMIT),
    [recentProblems, bySlug, byId]
  );

  // The plan-changed notice stays mounted across the skeleton: it is read once, when it first appears.
  const notice = <PlanChangedNotice className="mb-6" />;
  if (organizationsLoading || isLoading)
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 md:px-8">
        <Helmet>
          <title>OpenBinding - Dashboard</title>
        </Helmet>
        {notice}
        <DashboardSkeleton />
      </div>
    );

  const running = runs.filter(run => run.status === 'running' || run.status === 'queued').length;
  const firstOrg = organizations[0];
  const stats = [
    {
      label: 'Organizations',
      value: organizations.length,
      icon: 'mdi:domain',
      color: 'bg-tp-primary/10 text-tp-accent',
    },
    {
      label: 'Compositions',
      value: compositionsTotal,
      icon: 'mdi:tag-outline',
      color: 'bg-blue-50 text-blue-700',
    },
    {
      label: 'Runs running',
      value: running,
      icon: 'mdi:play-circle-outline',
      color: 'bg-purple-50 text-purple-700',
    },
  ];
  const quickActions = [
    {
      label: 'Browse compositions',
      description: 'Explore the public compositions',
      to: publicCompositionsPath(),
      icon: 'mdi:magnify',
    },
    {
      label: 'Composition editor',
      description: 'Write Composition2Yaml with live checks',
      to: '/editor',
      icon: 'mdi:code-braces',
    },
    {
      label: 'Problem editor',
      description: 'Check and compile a BIM package',
      to: '/workbench',
      icon: 'mdi:file-tree-outline',
    },
    ...(firstOrg
      ? [
          {
            label: 'Start a run',
            description: `Run an engine in ${firstOrg.name}`,
            to: launchPath(firstOrg.slug),
            icon: 'mdi:play-circle-outline',
          },
        ]
      : []),
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-8">
      <Helmet>
        <title>OpenBinding - Dashboard</title>
      </Helmet>
      {notice}

      {/* Welcome */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitionDefault}
        className="mb-8"
      >
        <h1 className="font-display text-3xl font-normal text-tp-ink">
          Welcome back, {user?.username ?? 'there'}
        </h1>
        <p className="mt-1 text-sm text-tp-steel">
          Here’s an overview of your OpenBinding workspace.
        </p>
      </motion.div>

      {/* Stats */}
      <motion.ul
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        aria-label="Your workspace in numbers"
        className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3"
      >
        {stats.map(stat => (
          <motion.li
            key={stat.label}
            variants={fadeInUp}
            transition={transitionDefault}
            className="flex items-center gap-4 rounded-xl border border-tp-hairline bg-tp-canvas p-4"
          >
            <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${stat.color}`}>
              <Iconify icon={stat.icon} width={20} />
            </div>
            <div>
              <p className="text-2xl font-semibold text-tp-ink">{stat.value}</p>
              <p className="text-xs text-tp-steel">{stat.label}</p>
            </div>
          </motion.li>
        ))}
      </motion.ul>

      {organizations.length === 0 ? (
        <motion.div
          initial="hidden"
          animate="visible"
          variants={fadeInUp}
          className="flex flex-col items-center gap-5 rounded-xl border border-dashed border-tp-hairline-strong bg-tp-surface/50 px-4 py-16 text-center"
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-tp-cream">
            <Iconify icon="mdi:domain" width={32} className="text-tp-primary" />
          </div>
          <div>
            <h2 className="text-base font-medium text-tp-ink">No organizations yet</h2>
            <p className="mt-1 max-w-md text-sm text-tp-steel">
              An organization holds your compositions, the problems they are chosen from, runs and
              studies, and the people who work on them.
            </p>
          </div>
          <Link
            to="/orgs/new"
            className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-tp-accent px-5 py-2.5 text-sm font-medium text-tp-on-primary hover:bg-tp-primary-deep"
          >
            <Iconify icon="mdi:plus" width={18} />
            Create organization
          </Link>
          <p className="text-xs text-tp-steel">
            I have an invitation link: open it, and you will join from there.
          </p>
        </motion.div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          <div className="min-w-0 space-y-6">
            <Section title="Recent organizations" viewAll="/me/orgs" delay={0.1}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {recentOrgs.map(org => (
                  <OrganizationCard key={org.id} org={org} />
                ))}
              </div>
            </Section>

            <Section title="Recent compositions" viewAll={myCompositionsPath()} delay={0.15}>
              {recentComps.length === 0 ? (
                <Empty>No compositions yet.</Empty>
              ) : (
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {recentComps.map(composition => (
                    <li key={composition.id}>
                      <Link
                        to={compositionPath(composition.organization.slug, composition.slug)}
                        className="block rounded-xl border border-tp-hairline bg-tp-canvas p-4 transition-colors hover:border-tp-hairline-strong hover:shadow-elevation-2"
                      >
                        <span className="block truncate text-sm font-medium text-tp-ink">
                          {composition.name}
                        </span>
                        <span className="block truncate text-[11px] text-tp-steel">
                          {composition.organization.name} · {composition.kind}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Recent problems" delay={0.2}>
              {recentProbs.length === 0 ? (
                <Empty>The problems you open show up here.</Empty>
              ) : (
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {recentProbs.map(item => (
                    <li key={`${item.orgId}/${item.id}`}>
                      <Link
                        to={problemPath(
                          bySlug.get(item.orgId)?.slug ?? byId.get(item.orgId)?.slug ?? item.orgId,
                          item.id
                        )}
                        className="block rounded-xl border border-tp-hairline bg-tp-canvas p-4 transition-colors hover:border-tp-hairline-strong"
                      >
                        <span className="block truncate text-sm font-medium text-tp-ink">
                          {item.name}
                        </span>
                        <span className="block truncate text-[11px] text-tp-steel">
                          {item.orgName}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Recent runs" delay={0.25}>
              {runs.length === 0 ? (
                <Empty>No runs yet.</Empty>
              ) : (
                <ul className="divide-y divide-tp-hairline rounded-xl border border-tp-hairline bg-tp-canvas">
                  {runs.map(run => (
                    <li key={run.id}>
                      <Link
                        to={runPath(run.orgSlug, run.id)}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-tp-surface/50"
                      >
                        <span className="min-w-0 flex-1 truncate font-medium text-tp-ink">
                          {run.problem?.name ?? run.engine_id}
                        </span>
                        <span className="text-xs text-tp-steel">
                          {run.engine_id} · {bySlug.get(run.orgSlug)?.name ?? run.orgSlug}
                        </span>
                        <span className="rounded-full bg-tp-surface px-2 py-0.5 text-[11px] font-semibold text-tp-steel">
                          {run.status}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>

          <motion.aside
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...transitionDefault, delay: 0.2 }}
            aria-label="Quick actions"
          >
            <h2 className="mb-3 text-sm font-medium text-tp-ink">Quick actions</h2>
            <ul className="space-y-2">
              {quickActions.map(action => (
                <li key={action.label}>
                  <Link
                    to={action.to}
                    className="group flex w-full cursor-pointer items-center gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-3 text-left transition-colors hover:border-tp-hairline-strong hover:shadow-elevation-1"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-tp-surface text-tp-steel group-hover:text-tp-accent">
                      <Iconify icon={action.icon} width={18} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-tp-ink">{action.label}</span>
                      <span className="block truncate text-xs text-tp-steel">
                        {action.description}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </motion.aside>
        </div>
      )}
    </div>
  );
}
