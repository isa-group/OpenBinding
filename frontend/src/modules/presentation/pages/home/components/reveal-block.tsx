// Adapted from SPHERE frontend/src/modules/presentation/pages/home/components/reveal-block.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: shown at once where IntersectionObserver is missing (tests, old browsers) and when motion is reduced.

import { useEffect, useRef, useState, type ReactNode } from 'react';

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function RevealBlock({
  children,
  className = '',
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const [isVisible, setIsVisible] = useState(
    () => typeof IntersectionObserver === 'undefined' || reducedMotion()
  );
  const revealRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = revealRef.current;
    if (!element || isVisible) return;
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.18, rootMargin: '0px 0px -12% 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [isVisible]);

  return (
    <div
      ref={revealRef}
      style={{ transitionDelay: `${delay}ms` }}
      className={`transform-gpu transition-all duration-[900ms] ease-[cubic-bezier(0.32,0.72,0,1)] ${
        isVisible ? 'blur-0 translate-y-0 opacity-100' : 'translate-y-16 opacity-0 blur-md'
      } ${className}`}
    >
      {children}
    </div>
  );
}
