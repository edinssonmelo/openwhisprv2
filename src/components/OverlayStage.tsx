import type { ReactNode } from 'react';

/** Full-viewport stage for transparent overlay: passes clicks through except interactive children. */
export function OverlayStage({ children }: { children: ReactNode }) {
  return (
    <div className="overlay-stage">
      <div className="overlay-stage-hit">{children}</div>
    </div>
  );
}
