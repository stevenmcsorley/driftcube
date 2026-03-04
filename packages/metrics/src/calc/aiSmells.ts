export interface AiSmells {
  dummyData: number;
  hardcodedSecrets: number;
  overAbstractedName: number;
  todoMarkers: number;
}

export function findAiSmells(source: string, symbolName: string): AiSmells {
  const lower = source.toLowerCase();
  const nameWords = symbolName.split(/(?=[A-Z])|_/g).filter(Boolean);

  return {
    dummyData: /\b(test|example|placeholder|mock|lorem ipsum)\b/.test(lower) ? 1 : 0,
    hardcodedSecrets: /\b(password|secret|token)\s*[:=]\s*["'][^"']+["']/.test(lower) ? 1 : 0,
    overAbstractedName: nameWords.length > 4 ? 1 : 0,
    todoMarkers: /\b(todo|fixme|not implemented)\b/.test(lower) ? 1 : 0,
  };
}
