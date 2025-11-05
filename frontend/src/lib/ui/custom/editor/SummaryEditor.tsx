import { Button } from "@/lib/ui/core/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from "@/lib/ui/core/shadcn/dialog";
import { MinimalTiptap } from "@/lib/ui/core/shadcn/minimal-tiptap";
import { getVisibleTextLength } from "@/lib/utils";

import { useState } from "react";

interface SummaryEditorProps {
  initialContent?: string;
  onApprove: (html: string) => void;
}

// TODO: Remove the "Godkend" button and handle it on "Næste" instead with a warning dialog
export const SummaryEditor = ({
  initialContent = "",
  onApprove,
}: SummaryEditorProps) => {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState(initialContent);
  const [isEditable, setIsEditable] = useState(true);

  const handleApprove = () => {
    onApprove(content);
    setIsEditable(false);
    setOpen(false);
  };

  return (
    <div className="space-y-4">
      <MinimalTiptap
        content={content}
        onChange={setContent}
        placeholder="Redigér dit resumé her..."
        editable={isEditable}
        className={!isEditable ? "bg-gray-100" : ""}
      />
      <div className="flex justify-end gap-2 pt-4">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              disabled={
                !content || getVisibleTextLength(content) <= 0 || !isEditable
              }
            >
              Godkend
            </Button>
          </DialogTrigger>
          <DialogContent showCloseButton={false}>
            <div className="p-5 space-y-2">
              <p>Er du sikker på, at du vil godkende dette resumé?</p>
              <p>Når du godkender, kan du ikke redigere det yderligere.</p>
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Annuller
              </Button>
              <Button onClick={handleApprove}>Godkend</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};
