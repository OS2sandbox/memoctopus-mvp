import { EXPORT_FORMAT } from "@/lib/constants";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/lib/ui/core/shadcn/select";

interface FormatDropdownMenuProps {
  onSelect: (format: EXPORT_FORMAT) => void;
  selected: EXPORT_FORMAT;
}

export const ExportFormatSelect = ({
  onSelect,
  selected,
}: FormatDropdownMenuProps) => {
  const options = Object.values(EXPORT_FORMAT);

  return (
    <Select
      onValueChange={(v) => onSelect(v as EXPORT_FORMAT)}
      value={selected as string}
    >
      <SelectTrigger>
        <SelectValue placeholder="Vælg eksportformat" />
      </SelectTrigger>
      <SelectContent>
        {options.map((format) => (
          <SelectItem key={format} value={format}>
            {format}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
