import { Link, useParams } from 'react-router-dom';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { NotFoundScreen } from '../../routes/NotFoundScreen';
import { LangExtensions } from '../Engines/LangExtensions';
import { Schemas } from '../Schemas/Schemas';
import { LanguageNav } from './languageSections';
import { Profiles } from './Profiles';
import './LanguageHub.css';

// [impl->req~frontend-nav-language-hub~1]

type Section = 'profiles' | 'schemas' | 'extensions';

/** The section an address names: none is the default one, an unknown name is `null`. */
function sectionOf(segment: string | undefined): Section | null {
  if (segment === undefined) return 'profiles';
  return segment === 'schemas' || segment === 'extensions' ? segment : null;
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
  return <LangExtensions />;
}

/** lang-profiles: one screen for the language, with Profiles & dialects, Schemas (by kind) and Extensions as sections. */
export function LanguageHub() {
  const { section: segment, item } = useParams();
  const section = sectionOf(segment);
  if (section === null || (item !== undefined && section !== 'schemas')) return <NotFoundScreen />;

  return (
    <div className="language-hub">
      <LanguageNav current={section} className="language-hub-nav" />
      {section === 'profiles' && <Profiles />}
      {section === 'schemas' && <Schemas kind={item ?? 'application'} />}
      {section === 'extensions' && <ExtensionsSection />}
    </div>
  );
}
