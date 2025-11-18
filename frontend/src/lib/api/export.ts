import { API_BASE_URL, type EXPORT_FORMAT } from "@/lib/constants";
import { getAuthHeaders, handleSafeFileName } from "@/lib/utils/utils";

export interface ExportRequest {
  format: EXPORT_FORMAT;
  markdown: string;
  fileName?: string;
}

// todo: temporary. Ugly code and handling
async function exportMarkdown({ format, markdown, fileName }: ExportRequest) {
  const headers = await getAuthHeaders();

  const res = await fetch(`${API_BASE_URL}/api/export`, {
    method: "POST",
    headers,
    body: JSON.stringify({ format, markdown }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `Failed to export markdown: ${errorText ?? res.statusText}`,
    );
  }

  const finalFilename = `${handleSafeFileName({ fileName })}.${format.toLowerCase()}`;

  const blob = await res.blob();
  return { blob, filename: finalFilename };
}

export async function downloadExport({
  format,
  markdown,
  fileName = "",
}: ExportRequest) {
  const { blob, filename } = await exportMarkdown({
    format,
    markdown,
    fileName,
  });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
