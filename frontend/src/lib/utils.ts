import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

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

// There's dayjs, but it's overkill for this simple task
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
  return `${twoDigits.format(m)}:${twoDigits.format(s)}`;
}

export const getVisibleTextLength = (html: string): number => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const text = doc.body.textContent?.trim() ?? "";
  return text.length;
};
