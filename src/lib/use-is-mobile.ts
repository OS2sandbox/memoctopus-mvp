'use client';

import { useEffect, useState } from 'react';

/**
 * SSR-safe viewport-width hook. Returns `false` on the server and on the first
 * client render (matching the server output, so hydration is stable), then
 * updates to the real value after mount and on every resize / breakpoint cross.
 *
 * Used to make the app's pixel-fixed inline-style layouts collapse on small
 * screens — inline styles win on specificity, so CSS media queries can't
 * override them; we branch the style objects in JS instead.
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [breakpoint]);

  return isMobile;
}
