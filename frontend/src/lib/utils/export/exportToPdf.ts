import { jsPDF } from "jspdf";

import type { ExportFileProps } from "@/lib/utils/export/types";
import { composeFormatRules } from "@/lib/utils/regex-rule-formatter/formatters";
import { safeNameRules } from "@/lib/utils/regex-rule-formatter/rules";

interface HandleSafeFileNameProps {
  fileName: string | undefined;
}

export const handleSafeFileName = ({ fileName }: HandleSafeFileNameProps) => {
  const result = fileName?.trim()
    ? composeFormatRules({ content: fileName, rules: safeNameRules })
    : `opsummering-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  return result;
};

// https://raw.githack.com/parallax/jsPDF/master/fontconverter/fontconverter.html
// TODO: temporary. must be handled in server-side for better pdf support
export const exportToPdf = ({ fileName, html }: ExportFileProps) => {
  const safeName = handleSafeFileName({ fileName: fileName });

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
    },
  });

  /*
      const pageWidth = pdf.internal.pageSize.getWidth();
      const margin = 40;
      const maxLineWidth = pageWidth - margin * 2;

      const lines = pdf.splitTextToSize(html, maxLineWidth);
      pdf.text(lines, margin, 60);
      pdf.save(`${safeName}.pdf`);
       */
};
