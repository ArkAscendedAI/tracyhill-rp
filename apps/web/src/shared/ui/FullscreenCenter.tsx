import type { PropsWithChildren } from "react";

export function FullscreenCenter({ children }: PropsWithChildren) {
  return <main className="shell">{children}</main>;
}
