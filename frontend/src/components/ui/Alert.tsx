import type { ReactNode } from 'react';
import './Alert.css';

interface AlertProps {
  type?: 'success' | 'warning' | 'error' | 'info';
  children: ReactNode;
  title?: string;
  onClose?: () => void;
}

export function Alert({ type = 'info', children, title, onClose }: AlertProps) {
  const icons = {
    success: '✓',
    warning: '⚠',
    error: '✕',
    info: 'ℹ'
  };

  return (
    <div
      className={`alert alert-${type}`}
      role={type === 'error' || type === 'warning' ? 'alert' : 'status'}
    >
      <div className="alert-icon" aria-hidden="true">{icons[type]}</div>
      <div className="alert-content">
        {title && <div className="alert-title">{title}</div>}
        <div className="alert-message">{children}</div>
      </div>
      {onClose && (
        <button className="alert-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      )}
    </div>
  );
}
