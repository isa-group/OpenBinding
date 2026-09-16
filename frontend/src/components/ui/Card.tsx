import type { ReactNode, CSSProperties } from 'react';
import './Card.css';

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  style?: CSSProperties;
}

export function Card({ children, className = '', padding = 'md', style }: CardProps) {
  const classes = [
    'card',
    `card-padding-${padding}`,
    className
  ].filter(Boolean).join(' ');

  return (
    <div className={classes} style={style}>
      {children}
    </div>
  );
}
