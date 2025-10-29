import { LucideCheck, LucideClipboardCopy, LucideEye } from "lucide-react";

import { Button } from "@/components/core/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from "@/components/core/shadcn/dialog";

import { Fragment, useState } from "react";

interface ViewPromptActionProps {
  promptText: string;
}
export const ViewPromptAction = ({ promptText }: ViewPromptActionProps) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <Dialog>
      <DialogTrigger>
        <Button variant="ghost" size="icon">
          <LucideEye className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <p>{promptText}</p>
        <DialogFooter>
          <Button size="sm" onClick={handleCopy}>
            {copied ? (
              <Fragment>
                <LucideCheck className="mr-2 h-4 w-4" />
                <span>Kopieret!</span>
              </Fragment>
            ) : (
              <Fragment>
                <LucideClipboardCopy className="mr-2 h-4 w-4" />
                <span>Kopier</span>
              </Fragment>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
