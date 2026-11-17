// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/CollectionsTab.tsx
// (revision 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the organization's studies, loaded by the tab itself from the gateway with server paging (`limit`, `offset`,
// `X-Total-Count`); each card reads its study's runs for the latest run's pill and the cells of that run for the bar. The
// Archived filter and the page live in the address; "New study" opens `/studies/new?org=` for MEMBER and above
// (OpenBinding's roles, not SPHERE's per-entity permissions); the gateway has no search for studies, so there is none here;
// a failed load says so with Retry.

import { motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { readApiError } from '../../../core/api/errors';
import { SYSTEM_TOAST } from '../../../core/contexts/toastKinds';
import { useToast } from '../../../core/contexts/useToast';
import customAlert from '../../../core/utils/custom-alert';
import customConfirm from '../../../core/utils/custom-confirm';
import Iconify from '../../../core/components/iconify';
import Pagination from '../../../core/components/pagination';
import { transitionDefault } from '../../../core/utils/motion-variants';
import type { OrgRole } from '../../../organization/api/organizationsApi';
import { newStudyPath, studyPath } from '../../../../routes/paths/studies';
import {
  studiesApi,
  useStudiesApi,
  type Study,
  type StudyCell,
  type StudyRun,
} from '../../api/studiesApi';
import { studyRefusal } from '../../utils/studyErrors';
import StudyCard from '../study-card';

/** Studies per page of the tab. */
export const PER_PAGE = 12;

interface Props {
  org: { slug: string; name: string };
  myRole: OrgRole | null;
}

interface Row {
  runs?: StudyRun[];
  latestCells?: StudyCell[];
}

export default function StudiesTab({ org, myRole }: Props) {
  const { getOrganizationStudies, getStudyRuns, getRunCells } = useStudiesApi();
  const [params, setParams] = useSearchParams();
  const [studies, setStudies] = useState<Study[]>([]);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const archived = params.get('archived') === 'true';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const canCreate = myRole === 'OWNER' || myRole === 'ADMIN' || myRole === 'MEMBER';
  const canAdminister = myRole === 'OWNER' || myRole === 'ADMIN';
  const { addToast } = useToast();
  const reload = () => setAttempt(value => value + 1);

  const archive = async (study: Study) => {
    try {
      await studiesApi.update(org.slug, study.slug, { archived: !study.archived });
      addToast({
        kind: SYSTEM_TOAST,
        title: study.archived
          ? `Study “${study.name}” restored.`
          : `Study “${study.name}” archived: it can’t start new runs, and existing results stay.`,
      });
      reload();
    } catch (caught) {
      const refusal = studyRefusal(caught, 'archive');
      void customAlert(`${refusal.title}. ${refusal.text}`, 'error');
    }
  };

  const remove = (study: Study) =>
    customConfirm(
      `Delete ${study.name}? The definition goes away for good. A study that already has runs can’t be deleted, because runs are history: it is archived instead, and its results stay.`,
      { danger: true, confirmLabel: 'Delete study' }
    )
      .then(async () => {
        try {
          await studiesApi.remove(org.slug, study.slug);
          addToast({ kind: SYSTEM_TOAST, title: `Study “${study.name}” deleted.` });
        } catch (caught) {
          const error = readApiError(caught);
          if (error.status === 409 && error.code === 'study_history_retained') {
            await studiesApi.update(org.slug, study.slug, { archived: true });
            addToast({
              kind: SYSTEM_TOAST,
              title: `${study.name} has runs, so it was archived instead of deleted. Its runs and results stay intact.`,
            });
          } else throw caught;
        }
        reload();
      })
      .catch(caught => {
        if (caught === undefined) return;
        const refusal = studyRefusal(caught, 'delete');
        void customAlert(`${refusal.title}. ${refusal.text}`, 'error');
      });

  const change = useCallback(
    (edit: (next: URLSearchParams) => void) =>
      setParams(
        previous => {
          const next = new URLSearchParams(previous);
          edit(next);
          return next;
        },
        { replace: true }
      ),
    [setParams]
  );

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SPHERE's loading flag, raised before each request
    setIsLoading(true);
    setError(null);
    getOrganizationStudies(
      org.slug,
      { archived, limit: PER_PAGE, offset: (page - 1) * PER_PAGE },
      controller.signal
    )
      .then(answer => {
        setStudies(answer.studies);
        setTotal(answer.total);
        setRows({});
        // Each card's latest run, and the cells of that run for a study that can still run.
        for (const study of answer.studies) {
          getStudyRuns(org.slug, study.slug, controller.signal)
            .then(async runs => {
              const latest = runs.reduce<StudyRun | undefined>(
                (best, run) => (!best || run.run_number > best.run_number ? run : best),
                undefined
              );
              setRows(now => ({ ...now, [study.id]: { runs } }));
              if (!latest || study.archived) return;
              const latestCells = await getRunCells(
                org.slug,
                study.slug,
                latest.id,
                controller.signal
              );
              setRows(now => ({ ...now, [study.id]: { runs, latestCells } }));
            })
            .catch(() => {
              if (!controller.signal.aborted)
                setRows(now => ({ ...now, [study.id]: { runs: now[study.id]?.runs ?? [] } }));
            });
        }
      })
      .catch(caught => {
        if (controller.signal.aborted) return;
        setStudies([]);
        setTotal(0);
        const refusal = readApiError(caught);
        setError(
          refusal.status === 403
            ? 'This credential can’t read studies. Use a session, or a key with studies:read.'
            : refusal.message
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [getOrganizationStudies, getStudyRuns, getRunCells, org.slug, page, archived, attempt]);

  return (
    <motion.section
      key="studies"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={transitionDefault}
      aria-label="Studies"
    >
      <div className="rounded-xl border border-tp-hairline bg-tp-canvas">
        <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-lg text-tp-ink">Studies</h2>
            <p className="text-xs text-tp-steel">
              Every combination of problems × engines × settings × seeds, run the same way so
              results compare fairly.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-tp-hairline-strong px-3 text-sm text-tp-slate">
              <input
                type="checkbox"
                checked={archived}
                onChange={event =>
                  change(next => {
                    if (event.target.checked) next.set('archived', 'true');
                    else next.delete('archived');
                    next.delete('page');
                  })
                }
                className="h-3.5 w-3.5 cursor-pointer accent-tp-primary"
              />
              Show archived studies
            </label>
            {canCreate && (
              <Link
                to={newStudyPath(org.slug)}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-tp-accent px-3 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                New study
              </Link>
            )}
          </div>
        </div>

        <div className="min-h-105 p-4">
          {isLoading ? (
            <p className="py-12 text-center text-sm text-tp-steel" role="status">
              Loading studies…
            </p>
          ) : error ? (
            <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
              <p className="text-sm text-red-700">The studies could not be loaded. {error}</p>
              <button
                type="button"
                onClick={reload}
                className="cursor-pointer rounded-lg border border-tp-hairline-strong px-3 py-1.5 text-xs font-medium text-tp-ink hover:border-tp-accent hover:text-tp-accent"
              >
                Retry
              </button>
            </div>
          ) : studies.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-tp-ink">
              <Iconify icon="mdi:chart-box-outline" width={32} />
              <p className="text-sm">{archived ? 'No studies found.' : 'No studies yet.'}</p>
              <p className="max-w-[28rem] text-xs text-tp-steel">
                2 problem versions × 2 engines × 2 seeds = 8 runs, all with the same rules. That’s a
                study.
              </p>
              {canCreate ? (
                <Link
                  to={newStudyPath(org.slug)}
                  className="mt-2 cursor-pointer text-sm font-medium text-tp-accent underline-offset-2 hover:underline"
                >
                  Build a study
                </Link>
              ) : (
                <p className="text-xs text-tp-steel">
                  Creating a study needs MEMBER in {org.name}.
                </p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {studies.map(study => (
                <StudyCard
                  key={study.id}
                  study={study}
                  to={studyPath(org.slug, study.slug)}
                  runs={rows[study.id]?.runs}
                  latestCells={rows[study.id]?.latestCells}
                  menuItems={[
                    ...(canCreate
                      ? [
                          {
                            label: study.archived ? 'Restore' : 'Archive',
                            onClick: () => void archive(study),
                          },
                        ]
                      : []),
                    ...(canAdminister
                      ? [
                          {
                            label: 'Delete',
                            variant: 'danger' as const,
                            onClick: () => void remove(study),
                          },
                        ]
                      : []),
                  ]}
                />
              ))}
            </div>
          )}
        </div>

        {total > PER_PAGE && (
          <div className="border-t border-tp-hairline px-5 py-3">
            <Pagination
              currentPage={page}
              totalPages={Math.ceil(total / PER_PAGE)}
              onPageChange={next =>
                change(search => {
                  if (next > 1) search.set('page', String(next));
                  else search.delete('page');
                })
              }
            />
          </div>
        )}
      </div>
    </motion.section>
  );
}
