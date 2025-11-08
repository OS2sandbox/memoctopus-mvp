import { DropdownMenuTrigger } from "@radix-ui/react-dropdown-menu";

import { Button } from "@/lib/ui/core/shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/lib/ui/core/shadcn/dropdown-menu";
import { Separator } from "@/lib/ui/core/shadcn/separator";

import { useState } from "react";

export enum ExportFormat {
  PDF = "PDF",
  DOCX = "DOCX",
  EMAIL = "Email",
}

interface ExportFormatDropdownMenuProps {
  onSelect: (format: ExportFormat) => void;
}

export const ExportFormatDropdownMenu = ({
  onSelect,
}: ExportFormatDropdownMenuProps) => {
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat | null>(
    null,
  );

  const handleFormatSelect = (format: ExportFormat) => {
    setSelectedFormat(format);
    onSelect(format);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          {selectedFormat ? selectedFormat : "Vælg eksportformat"}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Eksportér som</DropdownMenuLabel>

        <Separator />

        {Object.values(ExportFormat).map((format) => (
          <DropdownMenuItem
            onClick={() => handleFormatSelect(format)}
            key={format}
          >
            {format}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
