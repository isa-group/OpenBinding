import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './parts.css';

// The breadcrumb and the gate every screen of an organization's workspace shares.

export interface Crumb {
  label: string;
  to?: string;
}

/** `Home / Parent / This organization`: the last one is where you are. */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="org-crumbs">
      <ol>
        {items.map((item, index) => (
          <li key={`${item.label}:${index}`}>
            {index > 0 && <span aria-hidden="true">/</span>}
            {item.to && index < items.length - 1 ? (
              <Link to={item.to} viewTransition>
                {item.label}
              </Link>
            ) : (
              <span aria-current={index === items.length - 1 ? 'page' : undefined}>
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface GateProps {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}

/** A page-sized card that says why a screen is not shown. */
export function Gate({ title, children, action }: GateProps) {
  return (
    <div className="org-gate">
      <svg
        width="40"
        height="40"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <h2>{title}</h2>
      <p>{children}</p>
      {action && <div className="org-gate-actions">{action}</div>}
    </div>
  );
}
