import { PROMPT_CATEGORY } from "@/lib/constants";
import type { Prompt } from "@/lib/schemas/prompt";

export const mockPrompt: Prompt[] = [
  {
    id: "1",
    name: "Festudvalget på orto",
    creator: { id: "123", name: "Party Lars" },
    category: PROMPT_CATEGORY.Beslutningsreferat,
    isFavorite: true,
    text: "Lav et beslutningsreferat for mødet afholdt den 12. marts 2024...",
  },
  {
    id: "2",
    name: "Festudvalget på Tarm",
    creator: { id: "1234", name: "Camilla Nielsen" },
    category: PROMPT_CATEGORY.ToDoListe,
    isFavorite: false,
    text: "Lorem Ipsum Dolor Sit Amet 2",
  },
  {
    id: "3",
    name: "Test 3",
    creator: { id: "2313", name: "Anders Andersen" },
    category: PROMPT_CATEGORY.DetaljeretReferat,
    isFavorite: false,
    text: "Lorem Ipsum Dolor Sit Amet 43",
  },
  {
    id: "4",
    name: "4",
    creator: { id: "1234", name: "Camilla Nielsen" },
    category: PROMPT_CATEGORY.ToDoListe,
    isFavorite: false,
    text: "Lorem Ipsum Dolor Sit Amet 3124124",
  },
  {
    id: "5",
    name: "engelsk til dansk",
    creator: { id: "1234", name: "Camilla Nielsen" },
    category: PROMPT_CATEGORY.KortReferat,
    isFavorite: true,
    text: "generer et kort referat af denne engelske tekst på dansk",
  },
];
