import { Button } from "@/components/core/shadcn/button";
import { MinimalTiptap } from "@/components/core/shadcn/minimal-tiptap";

import { useState } from "react";

interface SummaryEditorProps {
  initialContent?: string;
  onApprove: (html: string) => void;
}

export const SummaryEditor = ({
  initialContent = "",
  onApprove,
}: SummaryEditorProps) => {
  const [content, setContent] = useState(initialContent);

  const getVisibleTextLength = (html: string): number => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const text = doc.body.textContent?.trim() ?? "";
    return text.length;
  };

  const handleApprove = () => {
    onApprove(content);
  };

  console.log(content);

  return (
    <div className="space-y-4">
      <MinimalTiptap
        content={content}
        onChange={setContent}
        placeholder="Redigér dit resumé her..."
      />

      <div className="flex justify-end gap-2 pt-4">
        <Button
          disabled={!content || getVisibleTextLength(content) <= 0}
          onClick={handleApprove}
        >
          Godkend
        </Button>
      </div>
    </div>
  );
};
