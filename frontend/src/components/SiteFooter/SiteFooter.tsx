import { Link } from 'react-router-dom';
import { InstitutionMark } from '../InstitutionMark';

const columns = [
  {
    title: 'Platform',
    links: [
      { label: 'Compositions', to: '/compositions' },
      { label: 'Language', to: '/language' },
      { label: 'Engines', to: '/engines' },
      { label: 'Pricing', to: '/pricing' },
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
            <strong>Compositions you can define, evaluate and compare</strong>
            <p>
              Define, version, evaluate, render and compare compositions; problems, written in BIM,
              say what was possible.
            </p>
          </div>

          <nav className="site-footer-nav" aria-label="Footer navigation">
            {columns.map(column => (
              <section key={column.title}>
                <span className="micro-label">{column.title}</span>
                {column.links.map(link => (
                  <Link key={link.label} to={link.to} viewTransition>
                    {link.label}
                  </Link>
                ))}
              </section>
            ))}
          </nav>

          <div className="site-footer-meta">
            <span>© {new Date().getFullYear()} OpenBinding</span>
            <div>
              <a href="https://score.us.es" target="_blank" rel="noreferrer">
                SCORE Lab
              </a>
              <a href="https://www.isa.us.es/3.0/" target="_blank" rel="noreferrer">
                ISA Group
              </a>
              <a href="https://www.us.es" target="_blank" rel="noreferrer">
                Universidad de Sevilla
              </a>
              <a href="https://github.com/isa-group/OpenBinding" target="_blank" rel="noreferrer">
                GitHub Source
              </a>
              <InstitutionMark variant="wide" className="site-footer-institution" />
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}
