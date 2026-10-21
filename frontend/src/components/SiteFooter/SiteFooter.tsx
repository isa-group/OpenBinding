import { Link } from 'react-router-dom';
import { InstitutionMark } from '../InstitutionMark';

const columns = [
  {
    title: 'Platform',
    links: [
      { label: 'Explore', to: '/explore' },
      { label: 'Engines', to: '/engines' },
      { label: 'Pricing', to: '/pricing' },
      { label: 'Status', to: '/status' },
    ],
  },
  {
    title: 'Language',
    links: [
      { label: 'Profiles & dialects', to: '/language' },
      { label: 'Schemas', to: '/language/schemas/application' },
      { label: 'Examples', to: '/examples' },
      { label: 'Workbench', to: '/workbench' },
    ],
  },
  {
    title: 'About',
    links: [
      { label: 'Team', to: '/about?tab=team' },
      { label: 'Research', to: '/about?tab=research' },
      { label: 'Funding', to: '/about?tab=funding' },
      { label: 'Changelog', to: '/about?tab=changelog' },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <>
      <div className="site-footer-band" aria-hidden="true" />
      <footer className="site-footer">
        <div className="site-footer-inner">
          <div className="site-footer-statement">
            <span className="micro-label">OpenBinding</span>
            <strong>Deterministic QoS binding for service compositions</strong>
            <p>Validate BIM v1 packages, run exact engine revisions and publish evidence anyone can verify by digest.</p>
          </div>

          <nav className="site-footer-nav" aria-label="Footer navigation">
            {columns.map((column) => (
              <section key={column.title}>
                <span className="micro-label">{column.title}</span>
                {column.links.map((link) => (
                  <Link key={link.label} to={link.to} viewTransition>{link.label}</Link>
                ))}
              </section>
            ))}
          </nav>

          <div className="site-footer-meta">
            <span>© {new Date().getFullYear()} OpenBinding</span>
            <div>
              <a href="https://score.us.es" target="_blank" rel="noreferrer">SCORE Lab</a>
              <a href="https://www.isa.us.es/3.0/" target="_blank" rel="noreferrer">ISA Group</a>
              <a href="https://www.us.es" target="_blank" rel="noreferrer">Universidad de Sevilla</a>
              <a href="https://github.com/isa-group/OpenBinding" target="_blank" rel="noreferrer">GitHub Source</a>
              <InstitutionMark variant="wide" className="site-footer-institution" />
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}
