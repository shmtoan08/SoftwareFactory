import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (path === join(root, "packages/test-harness")) continue;
      files.push(...productionTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

const productionSources = [
  ...productionTypeScriptFiles(join(root, "apps")),
  ...productionTypeScriptFiles(join(root, "packages")),
].sort();

function matchingLines(pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const file of productionSources) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (pattern.test(line)) matches.push(`${relative(root, file)}|${line.trim()}`);
    }
  }
  return matches.sort();
}

function liveModelDispatchLines(files: readonly string[] = productionSources): string[] {
  const configPath = join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const inspected = new Set(files);
  const matches: string[] = [];
  let clientType: ts.Type | undefined;

  const clientSource = program.getSourceFile(join(root, "packages/adapter-sdk/src/model-providers.ts"));
  assert(clientSource);
  for (const statement of clientSource.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === "LiveModelProviderClient") {
      const symbol = checker.getSymbolAtLocation(statement.name);
      assert(symbol);
      clientType = checker.getDeclaredTypeOfSymbol(symbol);
      break;
    }
  }
  assert(clientType);

  const assignableToClient = (type: ts.Type): boolean => {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
    if (type.isUnion()) return type.types.some(assignableToClient);
    return checker.isTypeAssignableTo(type, clientType!);
  };

  for (const source of program.getSourceFiles()) {
    if (!inspected.has(source.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "complete") {
        const receiverType = checker.getTypeAtLocation(node.expression.expression);
        if (assignableToClient(receiverType)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
          matches.push(`${relative(root, source.fileName)}|${source.text.split("\n")[line]!.trim()}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }
  return matches.sort();
}

test("T1-D inventories every typed LiveModelProviderClient dispatch site regardless of receiver name", () => {
  assert.deepEqual(liveModelDispatchLines(), [
    "packages/adapter-sdk/src/index.ts|const resp = await this.modelClient.complete({",
    "packages/adapter-sdk/src/model-providers.ts|completion = await this.client.complete({",
    "packages/adapter-sdk/src/model-providers.ts|const completion = await client.complete({",
  ]);
});

test("T1-D inventory recognizes a structurally declared subtype without matching its rendered type name", () => {
  assert.deepEqual(liveModelDispatchLines([
    join(root, "packages/test-harness/src/telemetry-readiness-subtype-fixture.ts"),
  ]), [
    "packages/test-harness/src/telemetry-readiness-subtype-fixture.ts|return provider.complete({ systemPrompt: \"fixture\", userPrompt: \"fixture\" });",
  ]);
});

test("T1-D pins the external model CLI dispatch surfaces and their current guard", () => {
  assert.deepEqual(matchingLines(/public readonly runtimeId = \"(?:claude-code|codex)-cli\"/), [
    'packages/adapter-sdk/src/codex-cli.ts|public readonly runtimeId = "codex-cli" as const;',
    'packages/adapter-sdk/src/index.ts|public readonly runtimeId = "claude-code-cli" as const;',
  ]);

  const codex = readFileSync(join(root, "packages/adapter-sdk/src/codex-cli.ts"), "utf8");
  const daemon = readFileSync(join(root, "packages/wna/src/daemon.ts"), "utf8");
  assert.match(codex, /ERR_UNMETERED_CODEX_DISABLED: production Codex requires trusted Cost Guard metering/);
  assert.match(daemon, /adapter\.runtimeId === "codex-cli" && !this\.testOnlyEmulator/);
  assert.match(daemon, /this\.sandboxBackend\.spawnRealProcessInSandbox\(\{/);
});

test("T1-D proves telemetry is not production-wired and TASK_BOUND remains disabled", () => {
  assert.deepEqual(matchingLines(/new CallTelemetryObserver\s*\(/), []);

  const pipeline = readFileSync(join(root, "packages/product-pipeline/src/pipeline-service.ts"), "utf8");
  assert.equal((pipeline.match(/new ManagedModelProviderExecutor\s*\(\{/g) ?? []).length, 4);
  assert.doesNotMatch(pipeline, /telemetryObserver\s*:/);

  const foundation = readFileSync(
    join(root, "packages/database/migrations/0017_t1_telemetry_authority_foundation.sql"),
    "utf8"
  );
  assert.match(foundation, /binding_state TEXT NOT NULL CHECK\(binding_state='CALL_ONLY'\)/);
  assert.doesNotMatch(foundation, /binding_state='TASK_BOUND'/);
});

test("T1-D pins bounded observer capacity without treating it as coverage authority", () => {
  const observer = readFileSync(join(root, "packages/adapter-sdk/src/call-telemetry.ts"), "utf8");
  assert.match(observer, /options\.maxEvents \?\? 1024/);
  assert.match(observer, /options\.maxBytes \?\? 16 \* 1024 \* 1024/);
  assert.match(observer, /bytes > 16 \* 1024/);
  assert.match(observer, /this\.#flight = this\.#queue\.splice\(0, 100\)/);
  assert.match(observer, /deadline: performance\.now\(\) \+ 60_000/);
});
