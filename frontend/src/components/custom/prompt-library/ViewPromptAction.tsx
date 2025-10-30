import { LucideCheck, LucideClipboardCopy, LucideEye } from "lucide-react";

import { Button } from "@/components/core/shadcn/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/core/shadcn/popover";

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
      <PopoverTrigger>
        <Button variant="ghost" size="icon">
          <LucideEye />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
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
