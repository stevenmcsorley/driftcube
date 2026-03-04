export function estimateCyclomaticComplexity(source: string): number {
  const branches = source.match(/\b(if|else if|for|while|case|catch)\b|&&|\|\||\?/g) ?? [];
  return 1 + branches.length;
}

export function estimateNestingDepth(source: string): number {
  let depth = 0;
  let maxDepth = 0;

  for (const char of source) {
    if (char === "{") {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
    }

    if (char === "}") {
      depth = Math.max(0, depth - 1);
    }
  }

  return maxDepth;
}

export function countLines(source: string): number {
  return source.split(/\r?\n/).length;
}

