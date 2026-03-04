import { basename } from "node:path";
import ts from "typescript";
import { deriveModuleName, type ExtractedSymbol } from "@driftcube/shared";
import { collectCallCandidates, collectImportSpecifiers } from "./imports.js";
import { hashCode, hashNormalizedCode } from "../normalize/astHash.js";
import { hashTokens } from "../normalize/tokenHash.js";

function lineAt(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function extractText(sourceFile: ts.SourceFile, node: ts.Node): string {
  return node.getText(sourceFile);
}

function createSymbol(
  sourceFile: ts.SourceFile,
  filePath: string,
  kind: ExtractedSymbol["kind"],
  name: string,
  node: ts.Node,
): ExtractedSymbol {
  const bodyText = extractText(sourceFile, node);
  return {
    symbolId: `${filePath}:${name}:${node.pos}:${node.end}`,
    kind,
    name,
    signature: name,
    startLine: lineAt(sourceFile, node.getStart(sourceFile)),
    endLine: lineAt(sourceFile, node.getEnd()),
    hash: hashCode(bodyText),
    normHash: hashNormalizedCode(bodyText),
    tokensHash: hashTokens(bodyText),
    modulePath: deriveModuleName(filePath),
    provenance: inferProvenance(bodyText),
    textRef: `inline://${filePath}#${name}`,
    bodyText,
    imports: collectImportSpecifiers(sourceFile.getFullText()),
    calls: collectCallCandidates(bodyText),
  };
}

function isFunctionInitializer(node: ts.Expression | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return Boolean(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)));
}

function defaultExportName(filePath: string): string {
  return basename(filePath).replace(/\.[^.]+$/, "") || "defaultExport";
}

function unwrapFunctionInitializer(node: ts.Expression | undefined): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (!node) {
    return undefined;
  }

  if (isFunctionInitializer(node)) {
    return node;
  }

  if (ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node)
    || ts.isPartiallyEmittedExpression(node)
    || ts.isSatisfiesExpression(node)) {
    return unwrapFunctionInitializer(node.expression);
  }

  if (ts.isCallExpression(node)) {
    for (const argument of node.arguments) {
      const nested = unwrapFunctionInitializer(argument);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function inferProvenance(bodyText: string): ExtractedSymbol["provenance"] {
  const lower = bodyText.toLowerCase();
  if (lower.includes("generated-by: claude")) return "claude";
  if (lower.includes("generated-by: codex")) return "codex";
  if (lower.includes("generated-by: cursor")) return "cursor";
  return "unknown";
}

export function extractTypeScriptSymbols(filePath: string, source: string): ExtractedSymbol[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const symbols: ExtractedSymbol[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push(createSymbol(sourceFile, filePath, "function", node.name.text, node));
    }

    if (ts.isFunctionDeclaration(node) && !node.name && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      symbols.push(createSymbol(sourceFile, filePath, "function", defaultExportName(filePath), node));
    }

    if (ts.isClassDeclaration(node) && node.name) {
      symbols.push(createSymbol(sourceFile, filePath, "class", node.name.text, node));
    }

    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      symbols.push(createSymbol(sourceFile, filePath, "method", node.name.text, node));
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const initializer = unwrapFunctionInitializer(declaration.initializer);
        if (!ts.isIdentifier(declaration.name) || !initializer) {
          continue;
        }

        symbols.push(createSymbol(
          sourceFile,
          filePath,
          "function",
          declaration.name.text,
          initializer,
        ));
      }
    }

    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const initializer = unwrapFunctionInitializer(node.initializer);
      if (initializer) {
        symbols.push(createSymbol(sourceFile, filePath, "function", node.name.text, initializer));
      }
    }

    if (ts.isExportAssignment(node)) {
      const initializer = unwrapFunctionInitializer(node.expression);
      if (initializer) {
        symbols.push(createSymbol(sourceFile, filePath, "function", defaultExportName(filePath), initializer));
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return symbols;
}
