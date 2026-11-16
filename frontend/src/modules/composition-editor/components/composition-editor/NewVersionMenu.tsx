// Adapted from SPHERE frontend/src/modules/pricing/components/new-version-menu/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the options open the Composition2Yaml editor (code, visual, upload) or lead to the runs a version is derived from;
// the markup uses OpenBinding's Action button, lucide icons and --tp-* CSS instead of Tailwind and react-icons.

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Code2, GitBranch, PenLine, Plus, UploadCloud } from 'lucide-react';
import { Action } from '../../../core/components/action-button';
import './NewVersionMenu.css';

interface Props {
  onVisualEditor: () => void;
  onCodeEditor: () => void;
  onUploadFile: () => void;
  /** Where the runs a version can be derived from are listed. */
  deriveHref: string;
}

interface Option {
  key: string;
  title: string;
  description: string;
  icon: ReactNode;
  onSelect?: () => void;
  to?: string;
}

export function NewVersionMenu({ onVisualEditor, onCodeEditor, onUploadFile, deriveHref }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const options: Option[] = [
    {
      key: 'code',
      title: 'Code editor',
      description: 'Edit the Composition2Yaml text',
      icon: <Code2 className="nvm-icon" aria-hidden="true" />,
      onSelect: onCodeEditor,
    },
    {
      key: 'visual',
      title: 'Visual editor',
      description: 'Choose candidates, values and the offering',
      icon: <PenLine className="nvm-icon" aria-hidden="true" />,
      onSelect: onVisualEditor,
    },
    {
      key: 'upload',
      title: 'Upload Composition2Yaml',
      description: 'Start a version from a YAML file',
      icon: <UploadCloud className="nvm-icon" aria-hidden="true" />,
      onSelect: onUploadFile,
    },
    {
      key: 'derive',
      title: 'Derive from a run',
      description: 'Open a run and derive a version from its solution',
      icon: <GitBranch className="nvm-icon" aria-hidden="true" />,
      to: deriveHref,
    },
  ];

  const body = (option: Option) => (
    <>
      {option.icon}
      <span>
        <span className="nvm-title">{option.title}</span>
        <span className="nvm-description">{option.description}</span>
      </span>
    </>
  );

  return (
    <div ref={menuRef} className="nvm">
      <Action
        variant="secondary"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <Plus aria-hidden="true" />
        New version
        <ChevronDown className={`nvm-chevron${open ? ' is-open' : ''}`} aria-hidden="true" />
      </Action>
      {open && (
        <div role="menu" aria-label="New version" className="nvm-menu">
          {options.map(option =>
            option.to ? (
              <Link
                key={option.key}
                role="menuitem"
                to={option.to}
                className="nvm-item"
                onClick={() => setOpen(false)}
              >
                {body(option)}
              </Link>
            ) : (
              <button
                key={option.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  option.onSelect?.();
                  setOpen(false);
                }}
                className="nvm-item"
              >
                {body(option)}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
