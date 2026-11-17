import { BRAND_ASSETS } from '../../../../content/brandAssets';
import {
  INSTITUTION_NAME,
  INSTITUTION_TITLE,
  INSTITUTION_URL,
  useInstitutionalBranding,
} from './institution';

export type InstitutionMarkVariant = 'compact' | 'wide';

const sources: Record<InstitutionMarkVariant, string> = {
  compact: BRAND_ASSETS.institutionMark,
  wide: BRAND_ASSETS.institutionWordmark,
};

/** The image's height per variant; `institution-mark` is only a hook the page checks find it by. */
const IMAGE: Record<InstitutionMarkVariant, string> = {
  compact: 'h-7',
  wide: 'h-11 max-w-48',
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

  const classes = [
    'institution-mark inline-flex flex-none items-center justify-center no-underline',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const image = (
    <img
      src={sources[variant]}
      alt={INSTITUTION_NAME}
      className={`block w-auto max-w-full object-contain ${IMAGE[variant]}`}
    />
  );

  if (variant === 'wide') {
    return (
      <a
        className={`${classes} cursor-pointer`}
        href={INSTITUTION_URL}
        target="_blank"
        rel="noreferrer"
        title={INSTITUTION_TITLE}
      >
        {image}
      </a>
    );
  }
  return (
    <span className={classes} title={INSTITUTION_TITLE}>
      {image}
    </span>
  );
}
