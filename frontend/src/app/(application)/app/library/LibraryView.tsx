import { PromptCategory } from "@/components/custom/prompt-library/table/Columns";
import { PromptTable } from "@/components/custom/prompt-library/table/PromptTable";

export const LibraryView = () => {
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
      id: "2",
      name: "EPJ input - venter på API",
      creator: { id: "123", name: "Party Lars" },
      category: PromptCategory.API,
      isFavorite: false,
      text: "Lorem Ipsum Dolor Sit Amet",
    },
    {
      id: "3",
      name: "Festudvalget på Tarm",
      creator: { id: "1234", name: "Camilla Nielsen" },
      category: PromptCategory.ToDoListe,
      isFavorite: false,
      text: "Lorem Ipsum Dolor Sit Amet 2",
    },
  ];

  return (
    <main className="min-h-screen flex flex-col items-center px-6 py-16 space-y-6">
      <h1 className="text-2xl font-semibold">Prompt-bibliotek</h1>
      <div className="flex flex-col w-full items-center justify-center pb-4">
        <p>Find et prompt og tilføj det til dine prompts.</p>
        <p>Du kan også oprette et nyt prompt.</p>
      </div>

      <PromptTable data={mockPrompts} />
    </main>
  );
};
