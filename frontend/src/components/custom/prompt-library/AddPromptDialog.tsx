import { LucidePlus } from "lucide-react";

import { Button } from "@/components/core/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@/components/core/shadcn/dialog";

export const AddPromptDialog = () => {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button className="btn btn-primary">
          <LucidePlus />
          Tilføj prompt
        </Button>
      </DialogTrigger>

      <DialogContent></DialogContent>
    </Dialog>
  );
};
