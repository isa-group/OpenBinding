import { useContext, useMemo, type ReactNode } from 'react';
import { UNSAFE_RouteContext as RouteContext } from 'react-router-dom';

/**
 * Exposes route parameters under the names an existing page still reads.
 *
 * The prototype renamed several segments (`:case` instead of `:caseSlug`). Until a page is
 * rebuilt it keeps calling `useParams()` with the old name, so the alias is added to the
 * matched route the page sees. The original parameter stays available.
 */
export function ParamAliases({ aliases, children }: { aliases: Record<string, string>; children: ReactNode }) {
  const parent = useContext(RouteContext);
  const value = useMemo(() => {
    const matches = parent.matches.map((match, index) => {
      if (index !== parent.matches.length - 1) return match;
      const params: Record<string, string | undefined> = { ...match.params };
      for (const [name, alias] of Object.entries(aliases)) {
        if (params[name] !== undefined) params[alias] = params[name];
      }
      return { ...match, params };
    });
    return { ...parent, matches };
  }, [parent, aliases]);

  return <RouteContext.Provider value={value}>{children}</RouteContext.Provider>;
}
