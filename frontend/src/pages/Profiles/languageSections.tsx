import { SectionNav } from '../../components/ui/SectionNav';

/** The sections of the language area, in order; the hub owns the first three, the Workbench is another screen. */
const LANGUAGE_SECTIONS = [
  { id: 'profiles', label: 'Profiles and dialects', to: '/language' },
  { id: 'schemas', label: 'Schemas', to: '/language/schemas' },
  { id: 'extensions', label: 'Extensions', to: '/language/extensions' },
  { id: 'workbench', label: 'Workbench', to: '/workbench' },
] as const;

export type LanguageSection = (typeof LANGUAGE_SECTIONS)[number]['id'];

/** Pill navigation between the language sections; the current one is not a link. */
export function LanguageNav({ current, className }: { current: LanguageSection; className?: string }) {
  return <SectionNav label="Language sections" items={LANGUAGE_SECTIONS} current={current} className={className} />;
}
