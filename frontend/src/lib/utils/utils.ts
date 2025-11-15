import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import { composeFormatRules } from "@/lib/utils/regex-rule-formatter/formatters";
import { safeNameRules } from "@/lib/utils/regex-rule-formatter/rules";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const getInitials = (name?: string): string => {
  if (!name) return "";

  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]?.[0]?.toUpperCase() ?? "?";

  const first = parts[0]?.[0]?.toUpperCase() ?? "";
  const last = parts[parts.length - 1]?.[0]?.toUpperCase() ?? "";
  return `${first}${last}`;
};

const twoDigits = new Intl.NumberFormat("en-US", {
  minimumIntegerDigits: 2,
  useGrouping: false,
});

export function formatTime(
  seconds: number,
  opts?: { showHours: boolean },
): string {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (opts?.showHours || h > 0) {
    return `${twoDigits.format(h)}:${twoDigits.format(m)}:${twoDigits.format(s)}`;
  }

  const result = `${twoDigits.format(m)}:${twoDigits.format(s)}`;

  return result;
}

export const getVisibleTextLength = (html: string): number => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const text = doc.body.textContent?.trim() ?? "";

  const result = text.length;

  return result;
};

interface HandleSafeFileNameProps {
  fileName?: string | undefined;
}

export const handleSafeFileName = ({ fileName }: HandleSafeFileNameProps) => {
  const result = fileName?.trim()
    ? composeFormatRules({ content: fileName, rules: safeNameRules })
    : `opsummering-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  return result;
};
