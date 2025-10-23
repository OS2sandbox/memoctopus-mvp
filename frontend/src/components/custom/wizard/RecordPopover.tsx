import { LucideMic } from "lucide-react";

import { Button } from "@/components/ui/core/shadcn/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/core/shadcn/popover";

export const RecordPopover = () => {
  return (
    <Popover>
      <PopoverTrigger>
        <Button size={"lg"}>
          <LucideMic /> Optag
        </Button>
      </PopoverTrigger>
      <PopoverContent>Lorem ipsum dolor sit amet</PopoverContent>
    </Popover>
  );
};
