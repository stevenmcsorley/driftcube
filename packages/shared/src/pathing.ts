import { dirname, join, normalize } from "node:path/posix";

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function deriveModuleName(filePath: string): string {
  const normalized = normalizePath(filePath);
  const parts = normalized.split("/").filter(Boolean);

  if (parts[0] === "src" && parts[1]) {
    return parts[1];
  }

  return parts[0] ?? "root";
}

export function resolveImportPath(sourceFilePath: string, importPath: string): string | null {
  if (!importPath.startsWith(".")) {
    return null;
  }

  const normalizedSource = normalizePath(sourceFilePath);
  const resolved = normalize(join(dirname(normalizedSource), importPath)).replace(/^\.\//, "");
  return resolved;
}

export function collapsePackageName(importPath: string): string {
  if (importPath.startsWith("@")) {
    const [scope, name] = importPath.split("/", 3);
    return scope && name ? `${scope}/${name}` : importPath;
  }

  return importPath.split("/", 1)[0] ?? importPath;
}

