import { access, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import ts from "typescript";

import { readProjectAgents, readProjectResources } from "./project.js";

export interface DoctorDiagnostic {
  code: string;
  severity: "error" | "warning";
  file: string;
  line?: number;
  message: string;
  hint: string;
}

export interface DoctorResult {
  ok: boolean;
  durationMs: number;
  diagnostics: DoctorDiagnostic[];
  summary: { errors: number; warnings: number; files: number };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sourceFiles(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

function envNames(source: string): Set<string> {
  return new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
}

function isLiteralHttpsOrigin(expression: ts.Expression): boolean {
  if (!ts.isStringLiteralLike(expression)) return false;
  try {
    const value = expression.text;
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) &&
      ((ts.isIdentifier(item.name) && item.name.text === name) ||
        (ts.isStringLiteralLike(item.name) && item.name.text === name)),
  );
}

function callName(node: ts.CallExpression): string | undefined {
  return ts.isIdentifier(node.expression) ? node.expression.text : undefined;
}

export async function doctorProject(projectRoot: string): Promise<DoctorResult> {
  const started = performance.now();
  const diagnostics: DoctorDiagnostic[] = [];
  const files = await sourceFiles(resolve(projectRoot, "opencomputer"));
  const requiredSecrets = new Set<string>();
  const toolNames = new Map<string, Array<{ file: string; line: number }>>();
  for (const path of files) {
    const source = await readFile(path, "utf8");
    const file = relative(projectRoot, path).split("\\").join("/");
    const syntax = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const toolCalls: Array<{ name?: string; line: number }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = callName(node);
        if (
          name === "useSecret" &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0])
        ) {
          requiredSecrets.add(node.arguments[0].text);
        }
        if (name === "defineConnection") {
          const definition = node.arguments[0];
          const origin =
            definition && ts.isObjectLiteralExpression(definition)
              ? property(definition, "origin")
              : undefined;
          const redirects =
            definition && ts.isObjectLiteralExpression(definition)
              ? property(definition, "redirectOrigins")
              : undefined;
          const redirectsValid =
            !redirects ||
            (ts.isArrayLiteralExpression(redirects.initializer) &&
              redirects.initializer.elements.every((item) => {
                if (!ts.isObjectLiteralExpression(item)) return false;
                const redirectOrigin = property(item, "origin");
                return Boolean(
                  redirectOrigin &&
                    isLiteralHttpsOrigin(redirectOrigin.initializer),
                );
              }));
          if (
            !origin ||
            !isLiteralHttpsOrigin(origin.initializer) ||
            !redirectsValid
          ) {
            const line =
              syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line +
              1;
            diagnostics.push({
              code: "connection_origin_not_literal",
              severity: "error",
              file,
              line,
              message:
                "Connection and redirect origins must be literal HTTPS origins without a path.",
              hint: 'Use `origin: "https://api.example.com"`.',
            });
          }
        }
        if (name === "defineTool") {
          const definition = node.arguments[0];
          const toolName =
            definition && ts.isObjectLiteralExpression(definition)
              ? property(definition, "name")
              : undefined;
          toolCalls.push({
            ...(toolName && ts.isStringLiteralLike(toolName.initializer)
              ? { name: toolName.initializer.text }
              : {}),
            line:
              syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line +
              1,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(syntax);
    if (toolCalls.length && !/\/agents\/[^/]+\/tools\//.test(`/${file}`)) {
      diagnostics.push({
        code: "tool_location_invalid",
        severity: "error",
        file,
        line: toolCalls[0]!.line,
        message: "Tools must be defined in an agent's tools/ directory.",
        hint: "Move the tool into opencomputer/agents/<agent>/tools/<name>.ts.",
      });
    }
    for (const tool of toolCalls) {
      if (tool.name) {
        const occurrences = toolNames.get(tool.name) ?? [];
        occurrences.push({ file, line: tool.line });
        toolNames.set(tool.name, occurrences);
      }
    }
    if (toolCalls.some((tool) => !tool.name)) {
      diagnostics.push({
        code: "tool_name_not_literal",
        severity: "error",
        file,
        message: "Every tool must declare one literal name.",
        hint: 'Use `defineTool({ name: "stable-tool-id", ... })`.',
      });
    }
  }
  for (const [name, occurrences] of [...toolNames].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (occurrences.length < 2) continue;
    diagnostics.push({
      code: "tool_name_duplicate",
      severity: "error",
      file: occurrences[1]!.file,
      line: occurrences[1]!.line,
      message: `Tool name ${name} is declared more than once.`,
      hint: "Give every tool in the project a unique literal name.",
    });
  }
  try {
    await readProjectAgents(projectRoot);
    await readProjectResources(projectRoot);
  } catch (error) {
    diagnostics.push({
      code: "project_contract_invalid",
      severity: "error",
      file: "opencomputer/",
      message: error instanceof Error ? error.message : String(error),
      hint: "Fix the referenced project, channel, scope, event, or resource declaration.",
    });
  }
  const examplePath = resolve(projectRoot, "opencomputer", ".env.example");
  const localPath = resolve(projectRoot, "opencomputer", ".env.local");
  const declared = envNames(
    (await exists(examplePath)) ? await readFile(examplePath, "utf8") : "",
  );
  const local = envNames(
    (await exists(localPath)) ? await readFile(localPath, "utf8") : "",
  );
  for (const name of [...requiredSecrets].sort()) {
    if (!declared.has(name)) {
      diagnostics.push({
        code: "secret_not_declared",
        severity: "error",
        file: "opencomputer/.env.example",
        message: `${name} is referenced by source but not declared.`,
        hint: `Add ${name}= without a value to opencomputer/.env.example.`,
      });
    }
    if (!local.has(name)) {
      diagnostics.push({
        code: "development_secret_missing",
        severity: "warning",
        file: "opencomputer/.env.local",
        message: `${name} has no local Development value.`,
        hint:
          `Add ${name} to the ignored .env.local file for local development; ` +
          `upload it separately with \`opencomputer secrets set ${name} --value-stdin\`.`,
      });
    }
  }
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.length - errors;
  return {
    ok: errors === 0,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    diagnostics,
    summary: { errors, warnings, files: files.length },
  };
}
