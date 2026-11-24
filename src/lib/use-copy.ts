'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const COPIED_MS = 2500;

/**
 * Copies text to the clipboard and reports the outcome for a confirmation.
 * `copied` clears itself after a moment; `failed` stays until the next copy, so
 * the caller can tell the user to copy by hand (no clipboard outside a secure
 * context, or the browser refused).
 */
export function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setCopied(false);
      setFailed(true);
      return;
    }
    setFailed(false);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, []);

  return { copied, failed, copy };
}
