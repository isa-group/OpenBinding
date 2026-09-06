import { useEffect, useState } from 'react';
import {
  ArrowUpRight, BookOpen, Box, CalendarDays, CircleDot, FlaskConical,
  Github, GraduationCap, Landmark, Network, Orbit, Search, Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { platformApi } from '../../api/platform';
import {
  contributionTracks, fundingEntities, relatedProjects, researchCorpus, team,
} from '../../content/platform';
import changelog from '../../content/changelog.generated.json';
import './PublicPages.css';

function PublicHeading({ eyebrow, title, lead }: { eyebrow: string; title: string; lead: string }) {
  return <header className="public-heading"><span>{eyebrow}</span><h1>{title}</h1><p>{lead}</p></header>;
}

export function ExplorePage() {
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof platformApi.publicProjects>>>([]);
  const [publications, setPublications] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => { void Promise.all([platformApi.publicProjects(), platformApi.publicPublications()]).then(([nextProjects, nextPublications]) => { setProjects(nextProjects); setPublications(nextPublications); }).catch(() => setError(true)).finally(() => setLoading(false)); }, []);
  return <div className="public-page explore-page"><PublicHeading eyebrow="Explore the observatory" title="Bindings worth reproducing." lead="Discover public projects and frozen evidence. Every published object points back to immutable BIM, engine and parameter revisions." />
    <section className="explore-search"><Search aria-hidden="true" /><label><span>Filter public resources</span><input type="search" placeholder="Cases, engines, authors, profiles…" disabled={!projects.length} /></label><small>{projects.length} projects · {publications.length} publications</small></section>
    {loading ? <div className="public-empty">Loading the public catalog…</div> : error ? <div className="public-empty" role="alert"><Orbit aria-hidden="true" /><h2>The catalog is temporarily unavailable</h2><p>Your public resources remain unchanged. Retry when the gateway is reachable.</p></div> : projects.length ? <div className="explore-grid">{projects.map(({ organization, project }) => <article key={`${organization.slug}/${project.slug}`}><div><span>{organization.name}</span><small>PUBLIC PROJECT</small></div><Network aria-hidden="true" /><h2>{project.name}</h2><p>{project.description || 'A public OpenBinding project.'}</p><footer><code>{organization.slug}/{project.slug}</code><ArrowUpRight aria-hidden="true" /></footer></article>)}</div> : <div className="public-empty"><Orbit aria-hidden="true" /><h2>The public catalog is ready</h2><p>Projects appear here only after their owner explicitly marks them public. Private work never leaks into Explore.</p><Link to="/register">Create the first project</Link></div>}
    {publications.length > 0 && <section className="publications-ledger"><header><span>Frozen evidence</span><h2>Published reports</h2></header>{publications.map((publication, index) => {
      const citation = publication.citation && typeof publication.citation === 'object' ? publication.citation as Record<string, unknown> : {};
      const report = publication.report && typeof publication.report === 'object' ? publication.report as Record<string, unknown> : {};
      const title = String(report.title ?? citation.title ?? publication.title ?? `Publication ${index + 1}`);
      const abstract = String(citation.abstract ?? publication.abstract ?? 'Immutable report with pinned binding and engine provenance.');
      return <article key={String(publication.id ?? publication.slug ?? index)}><BookOpen aria-hidden="true" /><div><span>{String(publication.organization ?? 'OpenBinding')} / {String(publication.project ?? 'public')}</span><h2>{title}</h2><p>{abstract}</p></div><ArrowUpRight aria-hidden="true" /></article>;
    })}</section>}
  </div>;
}

export function TeamPage() {
  return <div className="public-page"><PublicHeading eyebrow="People" title="Built where language design meets operations." lead="The public roster is intentionally small and sourced from repository contribution plus verified research profiles." />
    <div className="team-grid">{team.map((person) => <article key={person.name}><div className="team-avatar" aria-hidden="true">{person.initials}<i /><i /></div><span>{person.role}</span><h2>{person.name}</h2><p>{person.affiliation}</p><nav aria-label={`${person.name} profiles`}>{Object.entries(person.links).map(([name, url]) => <a key={name} href={url} target="_blank" rel="noreferrer">{name}<ArrowUpRight aria-hidden="true" /></a>)}</nav></article>)}</div>
    <aside className="public-integrity"><Github aria-hidden="true" /><div><strong>Contribution is the source of truth.</strong><p>Team changes are reviewed in Git. We omit unverified links rather than filling a card with guesses.</p></div></aside>
  </div>;
}

export function ResearchPage() {
  return <div className="public-page research-page"><PublicHeading eyebrow="Research" title="Literature becomes an executable corpus." lead="OpenBinding’s ICWS corpus derives workflows from published service-composition examples. Where a paper does not provide QoS numbers, the platform labels its illustrative values explicitly." />
    <div className="research-map"><div><span>6</span><small>source papers</small></div><i /><div><span>68+</span><small>problem variants</small></div><i /><div><span>4</span><small>engine families</small></div><i /><div><span>1</span><small>authoritative evaluator</small></div></div>
    <section className="research-source-heading"><h2>Sources represented in the executable corpus.</h2><p>Authors retain authorship of the original work; OpenBinding records only its derived test-case provenance and labels every illustrative value.</p></section>
    <section className="research-timeline">{researchCorpus.map((paper) => <article key={paper.doi}><time>{paper.year}</time><div><span>{paper.venue}</span><h2>{paper.title}</h2><p>{paper.authors}</p><footer><code>Corpus · {paper.corpus}</code><a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">DOI {paper.doi}<ArrowUpRight aria-hidden="true" /></a></footer></div></article>)}</section>
  </div>;
}

export function FundingPage() {
  return <div className="public-page"><PublicHeading eyebrow="Funding & ecosystem" title="Institutional context, with precise claims." lead="These entities are retained from the related SPHERE research ecosystem. Listing records provenance and context; it does not imply that every entity funds every OpenBinding release." />
    <aside className="funding-caveat"><strong>No OpenBinding-specific award is published</strong><p>These institutional and ecosystem links do not, by themselves, claim a specific grant. A grant will appear only with a verified reference, programme, period, role and official URL.</p></aside>
    <section className="funder-grid">{fundingEntities.map((entity, index) => <a href={entity.url} target="_blank" rel="noreferrer" key={entity.name}><span>{String(index + 1).padStart(2, '0')}</span>{entity.name === 'Universidad de Sevilla' ? <img src="/brands/universidad-sevilla.svg" alt="Universidad de Sevilla" /> : <Landmark aria-hidden="true" />}<h2>{entity.name}</h2><p>{entity.scope}</p><ArrowUpRight aria-hidden="true" /></a>)}</section>
    <section className="related-projects"><header><span>Projects and infrastructure</span><h2>What each project contributes</h2></header>{relatedProjects.map((project) => <a key={project.name} href={project.url} target="_blank" rel="noreferrer"><Box aria-hidden="true" /><strong>{project.name}<small>{project.kind}</small></strong><p>{project.role}</p><time>{project.period}</time><ArrowUpRight aria-hidden="true" /></a>)}</section>
  </div>;
}

export function ContributionsPage() {
  return <div className="public-page"><PublicHeading eyebrow="Open research tracks" title="Problems that deserve a careful solution." lead="Candidate thesis and research tracks extend OpenBinding’s language, engines and evidence model without introducing speculative platform dependencies." />
    <div className="contribution-grid">{contributionTracks.map((track, index) => <article key={track.title}><header><span>{String(index + 1).padStart(2, '0')}</span><GraduationCap aria-hidden="true" /></header><small>{track.level}</small><h2>{track.title}</h2><p>{track.description}</p><footer>{track.tags.map((tag) => <code key={tag}>{tag}</code>)}</footer></article>)}</div>
    <aside className="contribution-call"><FlaskConical aria-hidden="true" /><div><h2>Start from a reproducible question</h2><p>Proposals should identify a BIM invariant, an executable corpus and acceptance evidence before implementation begins.</p></div><a href="https://github.com/isa-group/OpenBinding/issues" target="_blank" rel="noreferrer">Discuss an idea <ArrowUpRight aria-hidden="true" /></a></aside>
  </div>;
}

export function ChangelogPage() {
  return <div className="public-page"><PublicHeading eyebrow="Changelog" title="Three release trains, one product history." lead="Platform behavior, language/engine contracts and documentation evolve independently, so each stream states exactly what changed." />
    <div className="change-columns">{Object.entries(changelog).map(([stream, releases]) => <section key={stream}><header>{stream === 'platform' ? <Users /> : stream === 'bim' ? <Network /> : <BookOpen />}<span>{stream}</span></header>{releases.map((release) => <article key={release.version}><div><strong>{release.version}</strong><time><CalendarDays />{release.date}</time></div><h2>{release.title}</h2><ul>{release.changes.map((change) => <li key={change}><CircleDot />{change}</li>)}</ul></article>)}</section>)}</div>
  </div>;
}

// Short aliases keep the public page API stable for existing imports.
export const Explore = ExplorePage;
export const Team = TeamPage;
export const Research = ResearchPage;
export const Funding = FundingPage;
export const Contributions = ContributionsPage;
export const Changelog = ChangelogPage;
