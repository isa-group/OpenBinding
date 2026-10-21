import { BRAND_ASSETS } from '../../content/brandAssets';
import {
  INSTITUTION_NAME, INSTITUTION_TITLE, INSTITUTION_URL, useInstitutionalBranding,
} from './institution';
import './InstitutionMark.css';

export type InstitutionMarkVariant = 'compact' | 'wide';

const sources: Record<InstitutionMarkVariant, string> = {
  compact: BRAND_ASSETS.institutionMark,
  wide: BRAND_ASSETS.institutionWordmark,
};

interface InstitutionMarkProps {
  variant?: InstitutionMarkVariant;
  className?: string;
}

/**
 * Co-brand of the Universidad de Sevilla. Renders nothing unless the signed-in
 * account is institutional. Assets are used as shipped (no filters or recolouring).
 * The compact variant is a plain mark meant to sit inside another link (the
 * brand link); the wide variant links to the university site.
 */
export function InstitutionMark({ variant = 'compact', className }: InstitutionMarkProps) {
  const institutional = useInstitutionalBranding();
  if (!institutional) return null;

  const classes = ['institution-mark', `institution-mark--${variant}`, className].filter(Boolean).join(' ');
  const image = <img src={sources[variant]} alt={INSTITUTION_NAME} />;

  if (variant === 'wide') {
    return (
      <a className={classes} href={INSTITUTION_URL} target="_blank" rel="noreferrer" title={INSTITUTION_TITLE}>
        {image}
      </a>
    );
  }
  return <span className={classes} title={INSTITUTION_TITLE}>{image}</span>;
}
