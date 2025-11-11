import { Document, Packer, Paragraph, TextRun } from "docx";
import { saveAs } from "file-saver";

import { handleSafeFileName } from "@/lib/utils/export/exportToPdf";
import type { ExportFileProps } from "@/lib/utils/export/types";
import { composeFormatRules } from "@/lib/utils/regex-rule-formatter/formatters";
import { htmlToTextRules } from "@/lib/utils/regex-rule-formatter/rules";

// TODO: temporary. must be handled in server-side for better docx support
export const exportToDocx = async ({ fileName, content }: ExportFileProps) => {
  const safeName = handleSafeFileName({ fileName: fileName });

  const textContent = composeFormatRules({
    content: content,
    rules: htmlToTextRules,
  });

  const paragraphs = textContent.split("/\n+/").map(
    (line) =>
      new Paragraph({
        children: [new TextRun({ text: line, size: 24 })],
        spacing: { after: 200 },
      }),
  );

  const doc = new Document({ sections: [{ children: paragraphs }] });
  const blob = await Packer.toBlob(doc);
  saveAs(blob, `${safeName}.docx`);
};
