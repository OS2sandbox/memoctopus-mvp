"use client";

import { LucideCheck, LucideClipboardCopy, LucideEye } from "lucide-react";

import { Button } from "@/lib/ui/core/shadcn/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/lib/ui/core/shadcn/popover";

import { Fragment, useState } from "react";

interface ViewPromptActionProps {
  promptText: string;
}
export const ViewPromptAction = ({ promptText }: ViewPromptActionProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(promptText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon">
          <LucideEye />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={"max-h-64 overflow-y-auto"}>
        <p className={"text-sm"}>{promptText}</p>
        <div className={"flex justify-start mt-4 items-center"}>
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
        </div>
      </PopoverContent>
    </Popover>
  );
};
