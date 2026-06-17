"use client";

import { useEffect } from "react";

/**
 * Warns the user before leaving or refreshing the page.
 * @param shouldWarn - Whether to show the confirmation dialog (typically used with useState)
 * @docs https://vercel.com/guides/leave-page-confirmation-dialog-before-unload-nextjs-react#confirm-navigation-away-with-event-listener
 */
export const useWarnBeforeUnload = (shouldWarn: boolean) => {
  useEffect(() => {
    if (!shouldWarn) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [shouldWarn]);
};
