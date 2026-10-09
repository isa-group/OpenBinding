import type { ReactNode } from 'react';
import { Notice } from '../../components/ui/Notice';
import { Breadcrumb, type Crumb } from '../Organization/parts';
import type { AnalysisProblem } from './analysisErrors';
import '../Project/Project.css';
import './Analysis.css';

interface AnalysisFrameProps {
  /** The crumbs below Home: `Analysis`, then the screen. The last one is where you are. */
  trail: Crumb[];
  children: ReactNode;
}

/** The frame of the analysis screens: breadcrumb and one content column. They are not about one project, so there are no project tabs. */
export function AnalysisFrame({ trail, children }: AnalysisFrameProps) {
  return (
    <div className="proj-frame an-frame">
      <div className="proj-band">
        <div className="proj-band-inner"><Breadcrumb items={[{ label: 'Home', to: '/app' }, ...trail]} /></div>
      </div>
      <div className="proj-body is-wide an-body">{children}</div>
    </div>
  );
}

const WARNING_KINDS = ['stale', 'key', 'conflict', 'busy'];

/** A refusal of the analysis calls, worded by `analysisProblem`. Warnings keep what is on screen valid; errors say nothing was done. */
export function ProblemNotice({ problem, action }: { problem: AnalysisProblem; action?: ReactNode }) {
  return <Notice tone={WARNING_KINDS.includes(problem.kind) ? 'warning' : 'error'} title={problem.title} action={action}>{problem.text}</Notice>;
}

/** A labelled figure in a grid of facts. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="an-fact"><span>{label}</span><strong>{children}</strong></div>;
}
