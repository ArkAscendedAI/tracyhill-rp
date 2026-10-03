import type { CSSProperties } from "react";

import type { IconName } from "./iconSprite";

/**
 * One glyph from the hand-built duotone sprite.
 * Decorative by default (aria-hidden): the surrounding button/label keeps carrying
 * the accessible name and title, so every existing selector and screen-reader
 * string is unchanged. Pass `label` for a standalone, meaningful icon.
 * Sizes: 14 chips/meta, 16 buttons and menu rows, 18 composer, 20 nav rail.
 */
export function Icon({ name, size = 16, className, label, style }: { name: IconName; size?: number; className?: string; label?: string; style?: CSSProperties }) {
  const cls = className ? `icon icon-${name} ${className}` : `icon icon-${name}`;
  return (
    <svg className={cls} width={size} height={size} style={style} aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label} focusable="false">
      <use href={`#th-${name}`} />
    </svg>
  );
}
