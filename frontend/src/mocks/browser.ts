import { setupWorker } from "msw/browser";

import { historyEntryHandlers, promptHandlers } from "@/mocks/handlers";

export const worker = setupWorker(...promptHandlers, ...historyEntryHandlers);
