// Adapted from shadcn/ui sidebar-07 registry (MIT); see LICENSES/shadcn-MIT.txt.
import { cn } from "../../lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  );
}

export { Skeleton };
