function hashToken(token: string): number {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = ((hash << 5) - hash + token.charCodeAt(index)) | 0;
  }

  return Math.abs(hash);
}

export function embedText(source: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  const tokens = source
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter(Boolean);

  for (const token of tokens) {
    const hash = hashToken(token);
    const index = hash % dimension;
    const sign = hash % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}
