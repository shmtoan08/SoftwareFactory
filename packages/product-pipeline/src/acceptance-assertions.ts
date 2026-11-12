import ts from "typescript";
import { PostgresRlsError } from "@software-factory/database";

/** Parse, allowlist and reprint assertions. Never splice caller source into trusted tests. */
export function compileAcceptanceAssertions(acId: string, lines: readonly string[] | undefined, exportName?: string): string[] {
  const locals = new Set<string>();
  const reserved = new Set(["mod", "assert", "Array", "targetPath", "implementedAcs", "implementedReqs", "exportedFns"]);
  const dangerous = new Set(["constructor", "prototype", "__proto__", "call", "apply", "bind", "then"]);
  const methods = new Set(["ok", "equal", "strictEqual", "notEqual", "notStrictEqual", "deepEqual", "deepStrictEqual", "match"]);
  const fail = (): never => { throw new PostgresRlsError("23514", `Stage 5 acceptance_specs['${acId}'] assertion_line contains a forbidden construct`); };
  const expression = (node: ts.Expression): boolean => {
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isRegularExpressionLiteral(node) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
    if (ts.isIdentifier(node)) return locals.has(node.text) || node.text === "undefined";
    if (ts.isParenthesizedExpression(node)) return expression(node.expression);
    if (ts.isPrefixUnaryExpression(node)) return [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.ExclamationToken].includes(node.operator) && expression(node.operand);
    if (ts.isBinaryExpression(node)) return [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanToken].includes(node.operatorToken.kind) && expression(node.left) && expression(node.right);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every((item) => expression(item));
    if (ts.isObjectLiteralExpression(node)) return node.properties.every((prop) => ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) && !dangerous.has(prop.name.text) && expression(prop.initializer));
    if (ts.isPropertyAccessExpression(node)) {
      if (node.questionDotToken || dangerous.has(node.name.text)) return false;
      if (ts.isIdentifier(node.expression) && node.expression.text === "mod") return ["implementedAcIds", "implementedRequirements"].includes(node.name.text);
      return expression(node.expression);
    }
    if (ts.isCallExpression(node) && !node.questionDotToken && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      if (callee.questionDotToken || dangerous.has(callee.name.text) || !node.arguments.every((arg) => expression(arg))) return false;
      if (ts.isIdentifier(callee.expression)) {
        if (callee.expression.text === "assert") return methods.has(callee.name.text);
        if (callee.expression.text === "Array") return callee.name.text === "isArray";
        if (callee.expression.text === "mod") return Boolean(exportName) && callee.name.text === exportName;
      }
      return callee.name.text === "includes" && expression(callee.expression);
    }
    return false;
  };
  if ((lines?.length ?? 0) > 64) fail();
  return (lines ?? []).map((line) => {
    if (line.length > 4096 || /[\r\n]/.test(line)) fail();
    const source = ts.createSourceFile("assertion.js", line, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    if ((source as ts.SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length || source.statements.length !== 1) fail();
    const statement = source.statements[0]!;
    if (ts.isVariableStatement(statement)) {
      if (!(statement.declarationList.flags & ts.NodeFlags.Const) || statement.declarationList.declarations.length !== 1) fail();
      const binding = statement.declarationList.declarations[0]!;
      if (!ts.isIdentifier(binding.name)) return fail();
      if (reserved.has(binding.name.text) || dangerous.has(binding.name.text) || locals.has(binding.name.text) || !binding.initializer || !expression(binding.initializer)) fail();
      locals.add(binding.name.text);
    } else if (!(ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
      ts.isPropertyAccessExpression(statement.expression.expression) && ts.isIdentifier(statement.expression.expression.expression) &&
      statement.expression.expression.expression.text === "assert" && expression(statement.expression))) fail();
    return ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Unspecified, statement, source);
  });
}
