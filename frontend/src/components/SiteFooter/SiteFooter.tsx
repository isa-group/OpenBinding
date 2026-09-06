import { ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { config } from '../../config';

const columns = [
  {
    title: 'Platform',
    links: [
      { label: 'Explore', to: '/explore' },
      { label: 'Workbench', to: '/playground' },
      { label: 'Engines', to: '/engines' },
      { label: 'Pricing', to: '/pricing' },
    ],
  },
  {
    title: 'BIM',
    links: [
      { label: 'Profiles & dialects', to: '/profiles' },
      { label: 'Example corpus', to: '/examples' },
      { label: 'Specification', to: '/schemas' },
      { label: 'API reference', href: `${config.apiBaseUrl}/docs` },
    ],
  },
  {
    title: 'Research',
    links: [
      { label: 'Publications', to: '/research' },
      { label: 'Team', to: '/team' },
      { label: 'Funding', to: '/funding' },
      { label: 'Contributions', to: '/contributions' },
      { label: 'Changelog', to: '/changelog' },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-statement">
          <span className="micro-label">OpenBinding</span>
          <strong>Binding problems become shared, reproducible evidence.</strong>
          <p>BIM v1 remains the stable language core. The platform adds the projects, studies, analysis and collaboration needed to carry a result from first case to published report.</p>
        </div>

        <nav className="site-footer-nav" aria-label="Footer navigation">
          {columns.map((column) => (
            <section key={column.title}>
              <span className="micro-label">{column.title}</span>
              {column.links.map((link) => 'to' in link ? (
                <Link key={link.label} to={link.to} viewTransition>{link.label}</Link>
              ) : (
                <a key={link.label} href={link.href} target="_blank" rel="noreferrer">{link.label}<ArrowUpRight aria-hidden="true" /></a>
              ))}
            </section>
          ))}
        </nav>

        <div className="site-footer-meta">
          <span>© {new Date().getFullYear()} OpenBinding · BIM v1 reference platform</span>
          <div>
            <a href="https://score.us.es" target="_blank" rel="noreferrer">SCORE Lab</a>
            <a href="https://www.isa.us.es/3.0/" target="_blank" rel="noreferrer">ISA Group</a>
            <a href="https://www.us.es" target="_blank" rel="noreferrer">Universidad de Sevilla</a>
            <a href="https://github.com/isa-group/OpenBinding" target="_blank" rel="noreferrer">Source</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
