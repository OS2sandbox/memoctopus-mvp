import { HttpResponse, http } from "msw";

import {
  type Prompt,
  PromptSchema,
  PromptWithIdSchema,
} from "@/lib/schemas/prompt";
import { loadPrompts, savePrompts } from "@/mocks/utils";

export const handlers = [
  http.get("/api/prompts", () => {
    const prompts = loadPrompts();
    const result = HttpResponse.json(prompts);

    return result;
  }),

  http.get("/api/prompts/:id", ({ params }) => {
    const prompts = loadPrompts();
    const prompt = prompts.find((p) => p.id === params["id"]);

    if (!prompt) {
      return HttpResponse.json(
        { message: "Prompt not found" },
        { status: 404 },
      );
    }

    const result = HttpResponse.json(prompt);

    return result;
  }),

  http.post("/api/prompts", async ({ request }) => {
    const body = await request.json();
    const promptDTO = PromptSchema.parse(body);
    const prompts = loadPrompts();

    const Prompt: Prompt = {
      id: crypto.randomUUID(),
      name: promptDTO.name,
      creator: promptDTO.creator,
      category: promptDTO.category,
      isFavorite: promptDTO.isFavorite,
      text: promptDTO.text,
    };

    savePrompts([Prompt, ...prompts]);
    const result = HttpResponse.json(Prompt, { status: 201 });

    return result;
  }),

  http.put("/api/prompts/:id", async ({ params, request }) => {
    const body = await request.json();
    const promptDTO = PromptWithIdSchema.parse(body);

    const updatedPrompts = loadPrompts().map((prompt) =>
      prompt.id === params["id"] ? { ...prompt, ...promptDTO } : prompt,
    );

    const exists = updatedPrompts.some((p) => p.id === params["id"]);
    if (!exists)
      return HttpResponse.json(
        { message: "Prompt not found" },
        { status: 404 },
      );

    savePrompts(updatedPrompts);
    const updatedPrompt = updatedPrompts.find((p) => p.id === params["id"]);

    return HttpResponse.json(updatedPrompt, { status: 200 });
  }),

  http.delete("/api/prompts", async ({ request }) => {
    const body = await request.json();
    const promptDTO = PromptSchema.parse(body);
    const prompts = loadPrompts();

    const updated = prompts.filter((p) => p.id !== promptDTO.id);
    savePrompts(updated);

    const result = HttpResponse.json({ id: promptDTO.id }, { status: 200 });

    return result;
  }),
];
