import { useId, useRef, useState } from 'react';
import './Tabs.css';

interface Tab {
  id: string;
  label: string;
  content: React.ReactNode;
  badge?: string | number;
}

interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
  ariaLabel?: string;
}

export function Tabs({ tabs, defaultTab, ariaLabel = 'Views' }: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.id);
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeContent = tabs.find((tab) => tab.id === activeTab)?.content;

  const moveFocus = (index: number) => {
    const bounded = (index + tabs.length) % tabs.length;
    const next = tabs[bounded];
    if (!next) return;
    setActiveTab(next.id);
    tabRefs.current[bounded]?.focus();
  };

  return (
    <div className="tabs-container">
      <div className="tabs-header" role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => { tabRefs.current[index] = node; }}
            id={`${baseId}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={`tab-button ${activeTab === tab.id ? 'tab-button-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') { event.preventDefault(); moveFocus(index + 1); }
              if (event.key === 'ArrowLeft') { event.preventDefault(); moveFocus(index - 1); }
              if (event.key === 'Home') { event.preventDefault(); moveFocus(0); }
              if (event.key === 'End') { event.preventDefault(); moveFocus(tabs.length - 1); }
            }}
          >
            {tab.label}
            {tab.badge !== undefined && <span className="tab-badge">{tab.badge}</span>}
          </button>
        ))}
      </div>
      <div
        id={`${baseId}-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${activeTab}`}
        className="tabs-content"
      >
        {activeContent}
      </div>
    </div>
  );
}
