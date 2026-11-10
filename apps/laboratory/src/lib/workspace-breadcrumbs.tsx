import { createContext, useContext, useLayoutEffect, useRef } from "react";

export interface WorkspaceCrumb {
  label: string;
  onNavigate?: () => void;
}
export interface WorkspaceTrail {
  items: WorkspaceCrumb[];
  onRoot?: () => void;
  disabled?: boolean;
}
export const WorkspaceBreadcrumbContext = createContext<
  ((section: string, trail: WorkspaceTrail) => void) | null
>(null);

/** Hidden sections retain their own trail; callbacks always use the current draft. */
export function useWorkspaceBreadcrumbs(
  section: string,
  items: WorkspaceCrumb[],
  onRoot?: () => void,
  disabled = false,
) {
  const register = useContext(WorkspaceBreadcrumbContext);
  const latest = useRef({ items, onRoot });
  latest.current = { items, onRoot };
  const key = JSON.stringify(
    items.map((item) => [item.label, Boolean(item.onNavigate)]),
  );
  const hasRoot = Boolean(onRoot);
  useLayoutEffect(() => {
    register?.(section, {
      items: latest.current.items.map((item, index) => ({
        label: item.label,
        onNavigate: item.onNavigate
          ? () => latest.current.items[index]?.onNavigate?.()
          : undefined,
      })),
      onRoot: hasRoot ? () => latest.current.onRoot?.() : undefined,
      disabled,
    });
  }, [register, section, key, hasRoot, disabled]);
}
