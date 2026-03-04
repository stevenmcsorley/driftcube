import { SupportedLanguages } from "./languages.js";

export function detectLanguageFromPath(path: string): string | undefined {
  const match = Object.entries(SupportedLanguages).find(([suffix]) => path.endsWith(suffix));
  return match?.[1];
}

