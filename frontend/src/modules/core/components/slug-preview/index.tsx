// Copied verbatim from SPHERE frontend/src/modules/core/components/slug-preview/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.

import { generateSlug } from '../../utils/generate-slug';

interface SlugPreviewProps {
  value: string;
}

export default function SlugPreview({ value }: SlugPreviewProps) {
  const slug = generateSlug(value);

  return (
    <p className="text-xs text-tp-steel">
      Slug: <span className="font-mono text-tp-ink">{slug}</span>
    </p>
  );
}
