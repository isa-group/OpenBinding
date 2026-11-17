import { useId, type ReactNode } from 'react';

/** One section of a mode: a region named by its small heading. */
export function RendererSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section
      className="cr-section flex min-w-0 flex-col gap-2 [&>h2]:m-0 [&>h2]:text-[15px] [&>h2]:font-semibold [&>h2]:text-tp-ink"
      aria-labelledby={id}
    >
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}
