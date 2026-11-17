import '../Compositions.css';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../../modules/auth/hooks/useAuth';
import { CompositionEditor } from '../../../modules/composition-editor/components/composition-editor/CompositionEditor';
import { compositionPath } from '../../../routes/paths/compositions';
import type {
  CompositionVersionView,
  CompositionView,
  SealResult,
} from '../../../modules/core/api/types';

/** What the New version menu asks the Editor to open on. */
export interface EditorEntry {
  pane?: 'code' | 'visual';
  upload?: boolean;
  toast?: string;
}

/**
 * Editor: the Composition2Yaml editor of the composition, starting from the version shown (or the starter when there is none).
 * A MEMBER seals; a VIEWER reads and checks the code. A new version opens in the Versions tab.
 */
export function EditorTab({
  org,
  composition,
  version,
  canSeal,
  onSealed,
}: {
  org: string;
  composition: CompositionView;
  version: Pick<CompositionVersionView, 'id' | 'label'> | null;
  canSeal: boolean;
  /** The composition and its versions must be read again: a version was sealed. */
  onSealed: () => void;
}) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const entry = (location.state as EditorEntry | null) ?? {};

  const sealed = (result: SealResult) => {
    onSealed();
    void navigate(
      compositionPath(org, composition.slug, 'versions', { version: result.version.label }),
      {
        state: { toast: `Version ${result.version.label} sealed.` },
        viewTransition: true,
      }
    );
  };

  return (
    <CompositionEditor
      key={`${version?.id ?? 'new'}:${location.key}`}
      org={org}
      composition={composition}
      version={version}
      userId={user?.id}
      canSeal={canSeal}
      initialPane={entry.pane}
      openUpload={entry.upload}
      onSealed={sealed}
      versionHref={label => compositionPath(org, composition.slug, undefined, { version: label })}
    />
  );
}
