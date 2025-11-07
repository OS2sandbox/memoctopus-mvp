import { useQuery } from "@tanstack/react-query";

import { getPrompts } from "@/lib/api/prompts";
import { FilterMode } from "@/lib/constants";
import { PromptTable } from "@/lib/ui/custom/prompt-library/table/PromptTable";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";

export const SelectPromptStep = () => {
  const query = useQuery({ queryKey: ["prompts"], queryFn: getPrompts });
  const mockPrompts = query.data ?? [];

  return (
    <WizardPanel>
      <PromptTable
        data={mockPrompts}
        tableMode={[FilterMode.Favorites, FilterMode.Mine]}
      />
    </WizardPanel>
  );
};
