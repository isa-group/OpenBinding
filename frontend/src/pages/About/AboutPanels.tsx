import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ArrowUpRight, Clock, FlaskConical, Github, Landmark, X } from 'lucide-react';
import { Chip } from '../../components/ui/Chip';
import type { ContributionTrack } from '../../content/platform';
import { ABOUT_TABS, changelogEntries, linkLabel, streamLabel, type AboutData } from './aboutModel';

export function PendingReview({ tab }: { tab: string }) {
  return (
    <div className="about-pending">
      <Clock aria-hidden="true" />
      <strong>Pending editorial review</strong>
      <span>Entries for {tab.toLowerCase()} appear once they’re reviewed.</span>
    </div>
  );
}

export function TeamPanel({ team }: { team: AboutData['team'] }) {
  if (!team.length) return <PendingReview tab="team" />;
  return (
    <>
      <ul className="about-team">
        {team.map((person, index) => (
          <li key={person.name}>
            <article aria-labelledby={`about-person-${index}`}>
              <span className="about-avatar" aria-hidden="true">{person.initials}</span>
              <h2 id={`about-person-${index}`}>{person.name}</h2>
              <span className="about-role">{person.role}</span>
              <Chip>{person.affiliation}</Chip>
              {Object.keys(person.links).length > 0 && (
                <nav aria-label={`${person.name} profiles`}>
                  {Object.entries(person.links).map(([name, url]) => (
                    <a key={name} href={url} target="_blank" rel="noreferrer">{linkLabel(name)}<ArrowUpRight aria-hidden="true" /></a>
                  ))}
                </nav>
              )}
            </article>
          </li>
        ))}
      </ul>
      <aside className="about-note">
        <Github aria-hidden="true" />
        <div>
          <strong>Contribution is the source of truth.</strong>
          <p>Team changes are reviewed in Git. We omit unverified links rather than filling a card with guesses.</p>
        </div>
      </aside>
    </>
  );
}

export function ResearchPanel({ research, facts }: { research: AboutData['research']; facts: AboutData['researchFacts'] }) {
  if (!research.length) return <PendingReview tab="research" />;
  return (
    <>
      <p className="about-lede">
        OpenBinding’s ICWS corpus derives workflows from published service-composition examples. Where a paper does not provide
        QoS numbers, the platform labels its illustrative values explicitly.
      </p>
      <ul className="about-facts" aria-label="The executable corpus in numbers">
        {facts.map((fact) => <li key={fact.label}><strong>{fact.value}</strong><span>{fact.label}</span></li>)}
      </ul>
      <section aria-labelledby="about-sources-title" className="about-sources">
        <h2 id="about-sources-title">Sources represented in the executable corpus.</h2>
        <p>
          Authors retain authorship of the original work; OpenBinding records only its derived test-case provenance and labels every
          illustrative value.
        </p>
      </section>
      <ol className="about-timeline">
        {research.map((paper) => (
          <li key={paper.doi}>
            <i aria-hidden="true" />
            <article>
              <span className="about-meta">{paper.venue} · {paper.year}</span>
              <h3>{paper.title}</h3>
              <p>{paper.authors}</p>
              <footer>
                <code>Corpus · {paper.corpus}</code>
                <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">DOI {paper.doi}<ArrowUpRight aria-hidden="true" /></a>
              </footer>
            </article>
          </li>
        ))}
      </ol>
    </>
  );
}

export function FundingPanel({ funding, related }: { funding: AboutData['funding']; related: AboutData['relatedProjects'] }) {
  if (!funding.length && !related.length) return <PendingReview tab="funding" />;
  return (
    <>
      <p className="about-lede">
        These entities are retained from the related SPHERE research ecosystem. Listing records provenance and context; it does not
        imply that every entity funds every OpenBinding release.
      </p>
      <ul className="about-funders">
        {funding.map((entity) => (
          <li key={entity.name}>
            <a href={entity.url} target="_blank" rel="noreferrer">
              <span className="about-logo">
                {entity.logo ? <img src={entity.logo} alt={entity.name} /> : <Landmark aria-hidden="true" />}
              </span>
              <strong>{entity.name}</strong>
              <span>{entity.scope}</span>
              <ArrowUpRight aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
      {related.length > 0 && (
        <section aria-labelledby="about-projects-title" className="about-projects">
          <header><span className="about-meta">Projects and infrastructure</span><h2 id="about-projects-title">What each project contributes</h2></header>
          <ul>
            {related.map((project) => (
              <li key={project.name}>
                <a href={project.url} target="_blank" rel="noreferrer">
                  <strong>{project.name}<small>{project.kind}</small></strong>
                  <span>{project.role}</span>
                  <time>{project.period}</time>
                  <ArrowUpRight aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function ContributionsPanel({ tracks }: { tracks: AboutData['contributions'] }) {
  const [open, setOpen] = useState<ContributionTrack | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  if (!tracks.length) return <PendingReview tab="contributions" />;
  return (
    <>
      <p className="about-lede">
        Candidate thesis and research tracks extend OpenBinding’s language, engines and evidence model without introducing speculative
        platform dependencies.
      </p>
      <ul className="about-tracks">
        {tracks.map((track) => (
          <li key={track.title}>
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={(event) => { opener.current = event.currentTarget; setOpen(track); }}
            >
              <strong>{track.title}</strong>
              <span>{track.description}</span>
              <span className="about-tags">
                <Chip tone="accent">{track.level}</Chip>
                {track.tags.map((tag) => <Chip key={tag} tone="accent">{tag}</Chip>)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <aside className="about-note">
        <FlaskConical aria-hidden="true" />
        <div>
          <strong>Start from a reproducible question</strong>
          <p>Proposals should identify a BIM invariant, an executable corpus and acceptance evidence before implementation begins.</p>
        </div>
        <a href="https://github.com/isa-group/OpenBinding/issues" target="_blank" rel="noreferrer">Discuss an idea <ArrowUpRight aria-hidden="true" /></a>
      </aside>
      {open && <ContributionDialog track={open} onClose={() => { setOpen(null); opener.current?.focus(); }} />}
    </>
  );
}

function ContributionDialog({ track, onClose }: { track: ContributionTrack; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useEffectEvent(onClose);

  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      // Focus stays inside the dialog while it is open.
      const focusable = dialog.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="about-modal">
      <button type="button" className="about-modal-backdrop" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="about-modal-title" className="about-modal-card">
        <div className="about-modal-head">
          <h2 id="about-modal-title">{track.title}</h2>
          <button ref={closeButton} type="button" aria-label="Close contribution" onClick={onClose}><X aria-hidden="true" /></button>
        </div>
        <p>{track.description}</p>
        <span className="about-tags">
          <Chip tone="accent">{track.level}</Chip>
          {track.tags.map((tag) => <Chip key={tag} tone="accent">{tag}</Chip>)}
        </span>
        {track.supervisor && <span className="about-supervisor"><span>Supervisor:</span> {track.supervisor}</span>}
        <a href="https://github.com/isa-group/OpenBinding/issues" target="_blank" rel="noreferrer">Discuss this on GitHub <ArrowUpRight aria-hidden="true" /></a>
      </div>
    </div>
  );
}

export function ChangelogPanel({ changelog }: { changelog: AboutData['changelog'] }) {
  const [stream, setStream] = useState('all');
  const streams = ['all', ...Object.keys(changelog)];
  const entries = changelogEntries(changelog, stream);
  if (!changelogEntries(changelog, 'all').length) return <PendingReview tab={ABOUT_TABS[4].label} />;
  return (
    <>
      <div role="group" aria-label="Stream" className="about-streams">
        {streams.map((name) => (
          <button key={name} type="button" aria-pressed={stream === name} onClick={() => setStream(name)}>
            {name === 'all' ? 'All' : streamLabel(name)}
          </button>
        ))}
      </div>
      <ol className="about-timeline">
        {entries.map((entry) => (
          <li key={`${entry.stream}-${entry.version}`}>
            <i aria-hidden="true" />
            <article>
              <span className="about-release-head">
                <code>{entry.version}</code>
                <Chip>{streamLabel(entry.stream)}</Chip>
                <span className="about-meta">{entry.date}</span>
              </span>
              <h3>{entry.title}</h3>
              {entry.changes.length
                ? <ul>{entry.changes.map((change) => <li key={change}>{change}</li>)}</ul>
                : <p>No changes recorded yet.</p>}
            </article>
          </li>
        ))}
      </ol>
    </>
  );
}
