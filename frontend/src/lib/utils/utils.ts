import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { jsPDF } from "jspdf";
import "@/lib/fonts/Roboto-normal"
import {formatToSafeFileName} from "@/lib/utils/regex-rule-formatter/formatters";

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

interface ExportToPDFProps {
    fileName: string;
    html: string;
}

// https://raw.githack.com/parallax/jsPDF/master/fontconverter/fontconverter.html
export const exportToPDF = ({ fileName, html }: ExportToPDFProps) => {
    const safeName = formatToSafeFileName({ fileName: fileName });

    const pdf = new jsPDF({
        orientation: "portrait",
        unit: "pt",
        format: "a4",
    });

    // TODO: temporary: jsPDF should be able to set font, but I couldn't get it to work with HTML for now
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    wrapper.style.fontFamily = "Roboto, sans-serif";
    wrapper.style.fontSize = "12pt";
    wrapper.style.lineHeight = "1.4";

    pdf.html(wrapper, {
        x: 40,
        y: 40,
        width: 520,
        windowWidth: 800,
        callback: (doc) => {
            doc.save(`${safeName}.pdf`);
        }
    });

    /*
    const pageWidth = pdf.internal.pageSize.getWidth();
    const margin = 40;
    const maxLineWidth = pageWidth - margin * 2;

    const lines = pdf.splitTextToSize(html, maxLineWidth);
    pdf.text(lines, margin, 60);
    pdf.save(`${safeName}.pdf`);
     */
}


