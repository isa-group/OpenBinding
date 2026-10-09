import { ArrowRight, ArrowUpRight, CheckCircle2, Code2, Cpu, Network } from 'lucide-react';
import { Link } from 'react-router-dom';
import './PublicPages.css';

function PublicHeading({ eyebrow, title, lead }: { eyebrow: string; title: string; lead: string }) {
  return <header className="public-heading"><span>{eyebrow}</span><h1>{title}</h1><p>{lead}</p></header>;
}

const workbenchSteps = [
  { icon: Code2, label: 'Author', title: 'Shape a binding package', description: 'Bring the instance, application, candidates and optimization resources into one inspectable case.' },
  { icon: Network, label: 'Inspect', title: 'Move between representations', description: 'Switch between structured forms, exact JSON or YAML, and BPMN without losing the same package.' },
  { icon: CheckCircle2, label: 'Validate', title: 'Catch issues before execution', description: 'Compile the package, check its contracts and read diagnostics before asking an engine to solve it.' },
  { icon: Cpu, label: 'Solve', title: 'Compare compatible outcomes', description: 'Choose an engine mode, run the case and inspect the returned solution space and analysis.' },
] as const;

export function WorkbenchPage() {
  return <div className="public-page workbench-page">
    <PublicHeading eyebrow="BIM Workbench" title="From package to evidence." lead="A focused workspace for turning a binding case into an executable, inspectable result. Work through the package in one place, then take the evidence into the platform." />

    <section className="workbench-flow" aria-labelledby="workbench-flow-title">
      <header><span className="section-label">The working loop</span><h2 id="workbench-flow-title">One package, four useful views.</h2><p>The Workbench keeps structure, source, validation and execution connected so you can change the case without losing track of what will run.</p></header>
      <div className="workbench-steps">
        {workbenchSteps.map(({ icon: Icon, label, title, description }, index) => <article key={label}>
          <div className="workbench-step-top"><span>{String(index + 1).padStart(2, '0')}</span><Icon aria-hidden="true" /></div>
          <span className="workbench-step-label">{label}</span>
          <h3>{title}</h3>
          <p>{description}</p>
        </article>)}
      </div>
    </section>

    <section className="workbench-entry" aria-labelledby="workbench-entry-title">
      <div><span className="section-label">Ready to work</span><h2 id="workbench-entry-title">Start with a package or a lesson.</h2><p>Open the editor with a starter package, or browse the example corpus first to see how different binding cases are assembled.</p></div>
      <div className="workbench-entry-actions"><Link to="/app" viewTransition>Open your workspace <ArrowRight aria-hidden="true" /></Link><Link to="/examples" viewTransition>Browse examples <ArrowUpRight aria-hidden="true" /></Link></div>
    </section>

    <nav className="workbench-related" aria-label="BIM Workbench related resources">
      <span className="section-label">Go deeper</span>
      <Link to="/language" viewTransition><strong>Profiles &amp; dialects</strong><span>Understand the language extension points</span><ArrowUpRight aria-hidden="true" /></Link>
      <Link to="/language/schemas/application" viewTransition><strong>Specification</strong><span>Inspect the exact BIM v1 contracts</span><ArrowUpRight aria-hidden="true" /></Link>
    </nav>
  </div>;
}
