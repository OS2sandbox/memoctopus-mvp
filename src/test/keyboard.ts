import type { UserEvent } from '@testing-library/user-event';

// Tab until `target` has focus, so a test proves the element is in the tab
// order without hard-coding how many stops come before it.
export async function tabTo(user: UserEvent, target: HTMLElement, maxTabs = 20): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    if (document.activeElement === target) return;
    await user.tab();
  }
  if (document.activeElement !== target) throw new Error('Never reached the target by pressing Tab');
}
