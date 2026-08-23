import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface RequirementTarget {
  readonly id: string;
  readonly text: string;
  readonly target: string;
  readonly file?: string;
  readonly testName?: string;
  readonly isCommand?: boolean;
}

export function parseRequirementsMd(content: string): RequirementTarget[] {
  const lines = content.split("\n");
  const targets: RequirementTarget[] = [];
  const reqRegex = /^[-\s]*\[[ x!]\]\s+(R\d+)\s+\|\s+(.*?)\s+\|\s+test:\s*(.*)$/;

  for (const line of lines) {
    const match = reqRegex.exec(line.trim());
    if (!match) continue;

    const id = match[1]!;
    const text = match[2]!.trim();
    const rawTarget = match[3]!.trim();

    if (rawTarget.includes("::")) {
      const [file, testName] = rawTarget.split("::");
      targets.push({
        id,
        text,
        target: rawTarget,
        file: file!.trim(),
        testName: testName!.trim(),
      });
    } else {
      targets.push({
        id,
        text,
        target: rawTarget,
        isCommand: true,
      });
    }
  }

  return targets;
}

export function extractExactTestNames(fileContent: string, fileName = "test.ts"): Set<string> {
  const names = new Set<string>();
  const sourceFile = ts.createSourceFile(
    fileName,
    fileContent,
    ts.ScriptTarget.Latest,
    true
  );

  function isTestCallee(node: ts.Expression): boolean {
    if (ts.isIdentifier(node)) {
      return node.text === "test" || node.text === "it";
    }
    if (ts.isPropertyAccessExpression(node)) {
      return (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "test" || node.expression.text === "it") &&
        node.name.text === "only"
      );
    }
    return false;
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      if (isTestCallee(node.expression) && node.arguments.length >= 1) {
        const firstArg = node.arguments[0];
        if (
          firstArg &&
          (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))
        ) {
          names.add(firstArg.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return names;
}

test("exact_name_matching_rejects_similar_names: proves AST ignores comments, strings, and renamed similar tests", () => {
  const sampleWithNoise = `
    // test("commented_out_test", () => {});
    /*
      it("block_commented_test", () => {});
    */
    const templateNoise = \`test("noise_in_template_literal", () => {})\`;
    const stringNoise = 'it("noise_in_regular_string", () => {})';
    function myCustomHelper(name: string, fn: any) {}
    myCustomHelper("helper_not_test_callee", () => {});

    test("preserves_requirement_text: parses atomic IDs", () => {});
    test("rejects_duplicate_ids - custom description", () => {});
  `;

  const extractedNoise = extractExactTestNames(sampleWithNoise);
  assert.equal(extractedNoise.has("commented_out_test"), false, "Must not match line comments");
  assert.equal(extractedNoise.has("block_commented_test"), false, "Must not match block comments");
  assert.equal(extractedNoise.has("noise_in_template_literal"), false, "Must not match template strings");
  assert.equal(extractedNoise.has("noise_in_regular_string"), false, "Must not match regular strings");
  assert.equal(extractedNoise.has("helper_not_test_callee"), false, "Must not match custom functions");
  assert.equal(extractedNoise.has("preserves_requirement_text"), false, "Must not match prefixed/suffixed names");
  assert.equal(extractedNoise.has("rejects_duplicate_ids"), false, "Must not match prefixed/suffixed names");

  const sampleExact = `
    test("preserves_requirement_text", () => {});
    it('rejects_duplicate_ids', () => {});
    test.only("focused_exact_test", () => {});
    test.skip(\`skipped_exact_test\`, () => {});
    test.todo("todo_exact_test");
  `;
  const extractedExact = extractExactTestNames(sampleExact);
  assert.equal(extractedExact.has("preserves_requirement_text"), true);
  assert.equal(extractedExact.has("rejects_duplicate_ids"), true);
  assert.equal(extractedExact.has("focused_exact_test"), true);
  assert.equal(extractedExact.has("skipped_exact_test"), false);
  assert.equal(extractedExact.has("todo_exact_test"), false);
});

test("all_requirements_have_exact_named_tests: checks active exact test traceability for R1-R79", () => {
  const rootDir = path.resolve(__dirname, "../../");
  const reqFilePath = path.join(rootDir, ".omni/sdlc/requirements.md");
  const content = fs.readFileSync(reqFilePath, "utf-8");
  const requirements = parseRequirementsMd(content);

  assert.equal(requirements.length, 79, `Expected exactly 79 requirements, found ${requirements.length}`);
  assert.deepEqual(
    requirements.map((requirement) => requirement.id),
    Array.from({ length: 79 }, (_, index) => `R${index + 1}`),
    "Requirements must remain uniquely ordered from R1 through R79"
  );

  const commandRequirements = requirements.filter((requirement) => requirement.isCommand);
  assert.deepEqual(
    commandRequirements.map((requirement) => ({ id: requirement.id, target: requirement.target })),
    [{ id: "R79", target: "npm test" }],
    "R79 must remain the only command-level requirement and must target npm test"
  );

  const missing: Array<{ id: string; file: string; testName: string; reason: string }> = [];

  for (const req of requirements) {
    if (req.isCommand) {
      // Command-level requirement (e.g. R79: npm test)
      continue;
    }

    if (!req.file || !req.testName) {
      missing.push({
        id: req.id,
        file: req.target,
        testName: "",
        reason: "Target does not have file::testName format",
      });
      continue;
    }

    const fullFilePath = path.resolve(rootDir, req.file);
    if (!fs.existsSync(fullFilePath)) {
      missing.push({
        id: req.id,
        file: req.file,
        testName: req.testName,
        reason: `File '${req.file}' does not exist on disk`,
      });
      continue;
    }

    const fileContent = fs.readFileSync(fullFilePath, "utf-8");
    const exactTests = extractExactTestNames(fileContent);

    if (!exactTests.has(req.testName)) {
      missing.push({
        id: req.id,
        file: req.file,
        testName: req.testName,
        reason: `Exact test name '${req.testName}' not found in '${req.file}'`,
      });
    }
  }

  if (missing.length > 0) {
    const listStr = missing
      .map((m) => `  - [${m.id}] ${m.file}::${m.testName} (${m.reason})`)
      .join("\n");
    assert.fail(
      `Traceability guard: Missing ${missing.length} exact requirement tests:\n${listStr}`
    );
  }
});
