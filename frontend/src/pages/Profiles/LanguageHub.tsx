import { Link, useParams } from 'react-router-dom';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { LangExtensions } from '../Engines/LangExtensions';
import { Schemas } from '../Schemas/Schemas';
import { Profiles } from './Profiles';
import './LanguageHub.css';

// [impl->req~frontend-nav-language-hub~1]

type Section = 'profiles' | 'schemas' | 'extensions';

const SECTIONS: ReadonlyArray<{ id: Section; label: string; to: string }> = [
  { id: 'profiles', label: 'Profiles and dialects', to: '/language' },
  { id: 'schemas', label: 'Schemas', to: '/language/schemas' },
  { id: 'extensions', label: 'Extensions', to: '/language/extensions' },
];

/** The section an address names: none is the default one, an unknown name is `null`. */
function sectionOf(segment: string | undefined): Section | null {
  if (segment === undefined) return 'profiles';
  return SECTIONS.find((section) => section.id === segment && section.id !== 'profiles')?.id ?? null;
}

function HubNav({ current }: { current: Section | null }) {
  return (
    <nav className="language-hub-nav" aria-label="Language sections">
      {SECTIONS.map((section) => (
        section.id === current
          ? <span key={section.id} aria-current="page">{section.label}</span>
          : <Link key={section.id} to={section.to}>{section.label}</Link>
      ))}
      <Link to="/examples">Examples</Link>
      <Link to="/workbench">Workbench</Link>
    </nav>
  );
}

/** The extensions of the language need a session: signed out, the section explains that and offers the login. */
function ExtensionsSection() {
  const { user, loading } = useAuth();
  if (loading) return <div className="language-hub-wait" aria-busy="true"><Skeleton variant="panel" /></div>;
  if (!user) {
    return (
      <section className="language-hub-signed-out" aria-label="Extensions">
        <h1>Language extensions</h1>
        <p>
          Extensions teach OpenBinding new kinds of resources: dialects, adapters and registered resources. The list of what is installed,
          and where each one comes from, is shown to people who are logged in.
        </p>
        <Link to="/login">Log in to see and manage language extensions</Link>
      </section>
    );
  }
  return <LangExtensions embedded />;
}

/** lang-profiles: one screen for the language, with Profiles & dialects, Schemas (by kind) and Extensions as sections. */
export function LanguageHub() {
  const { section: segment, item } = useParams();
  const section = sectionOf(segment);

  return (
    <div className="language-hub">
      <HubNav current={section} />
      {section === 'profiles' && <Profiles embedded />}
      {section === 'schemas' && <Schemas embedded kind={item ?? 'application'} />}
      {section === 'extensions' && <ExtensionsSection />}
      {section === null && (
        <section className="language-hub-unknown" aria-label="Unknown section">
          <h1>Language</h1>
          <Notice tone="error" title={`There is no “${segment}” section (404)`}>
            The language has Profiles &amp; dialects, Schemas and Extensions. Pick one above.
          </Notice>
        </section>
      )}
    </div>
  );
}
