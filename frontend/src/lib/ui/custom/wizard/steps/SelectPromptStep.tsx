import { FilterMode, PromptCategory } from "@/lib/constants";
import { PromptTable } from "@/lib/ui/custom/prompt-library/table/PromptTable";
import { WizardContentPanel } from "@/lib/ui/custom/wizard/WizardContentPanel";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";

export const SelectPromptStep = () => {
  const mockPrompts = [
    {
      id: "1",
      name: "Festudvalget på orto",
      creator: { id: "123", name: "Party Lars" },
      category: PromptCategory.Beslutningsreferat,
      isFavorite: true,
      text: "Lav et beslutningsreferat for mødet afholdt den 12. marts 2024...",
    },
    {
      id: "3",
      name: "Festudvalget på Tarm",
      creator: { id: "1234", name: "Camilla Nielsen" },
      category: PromptCategory.ToDoListe,
      isFavorite: true,
      text: "Lorem Ipsum Dolor Sit Amet 2",
    },
  ];

  return (
    <WizardPanel>
      <WizardContentPanel>
        <PromptTable
          data={mockPrompts}
          tableMode={[FilterMode.Favorites, FilterMode.Mine]}
        />
      </WizardContentPanel>
    </WizardPanel>
  );
};
