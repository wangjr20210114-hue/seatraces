// Compatibility exports: existing HTTP handlers and clients retain their contracts.
export { toGcj, toWgs } from "../public/coordinates.js";
export { providerStatus } from "./config/providers.mjs";
export { llmJSON } from "./integrations/deepseek.mjs";
export { trainSearch, flightSearch } from "./integrations/travel-tickets.mjs";
export { personalizedQuestions } from "./services/questions.mjs";
export { demoRoute, normalizeTransit, route } from "./services/routes.mjs";
export { nameSimilarity } from "./domain/place-matching.mjs";
export { matchPlace } from "./services/place-matching.mjs";
