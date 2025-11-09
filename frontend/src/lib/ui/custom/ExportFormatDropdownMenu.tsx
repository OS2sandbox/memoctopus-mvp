import { DropdownMenuTrigger } from "@radix-ui/react-dropdown-menu";

import { EXPORT_FORMAT } from "@/lib/constants";
import { Button } from "@/lib/ui/core/shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/lib/ui/core/shadcn/dropdown-menu";
import { Separator } from "@/lib/ui/core/shadcn/separator";

interface EXPORT_FORMATDropdownMenuProps {
  onSelect: (format: EXPORT_FORMAT) => void;
  selected: EXPORT_FORMAT;
}

export const FormatDropdownMenu = ({
  onSelect,
  selected,
}: EXPORT_FORMATDropdownMenuProps) => {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          {selected ? selected : "Vælg eksportformat"}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Eksportér som</DropdownMenuLabel>

        <Separator />

        {Object.values(EXPORT_FORMAT).map((format) => (
          <DropdownMenuItem
            disabled={EXPORT_FORMAT.EMAIL === format}
            onClick={() => onSelect(format)}
            key={format}
          >
            {format}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
