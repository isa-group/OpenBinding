import { useId, type ReactNode } from 'react';

/** One section of a mode: a region named by its small heading. */
export function RendererSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="cr-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}
