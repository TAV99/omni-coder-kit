import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { NodeProcessRunner } from "../../src/v4/process/node-process-runner";

const fixturePath = path.resolve(__dirname, "../fixtures/v4/process-fixture.cjs");

test("process-runner: pre-aborted signal returns aborted and never throws", async () => {
  const runner = new NodeProcessRunner();
  const abortController = new AbortController();
  abortController.abort(); // Pre-aborted

  const result = await runner.run({
    command: process.execPath,
    args: [fixturePath, "echo", "should not run"],
    cwd: process.cwd(),
    timeoutMs: 5000,
    signal: abortController.signal,
  });

  assert.equal(result.termination, "aborted");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("process-runner: args with spaces and shell metacharacters are passed verbatim", async () => {
  const runner = new NodeProcessRunner();
  const trickyArg1 = "hello world & foo | bar";
  const trickyArg2 = '$VAR `whoami` "quotes"';
  const stdinData = "test input content";

  const result = await runner.run({
    command: process.execPath,
    args: [fixturePath, "echo", trickyArg1, trickyArg2],
    cwd: process.cwd(),
    stdin: stdinData,
    timeoutMs: 5000,
  });

  assert.equal(result.termination, "exited");
  if (result.termination === "exited") {
    assert.equal(result.exitCode, 0);
  }

  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.args, [trickyArg1, trickyArg2]);
  assert.equal(parsed.input, stdinData);
});

test("process-runner: captures stderr and non-zero exit code separately", async () => {
  const runner = new NodeProcessRunner();

  const result = await runner.run({
    command: process.execPath,
    args: [fixturePath, "stderr"],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.equal(result.termination, "exited");
  if (result.termination === "exited") {
    assert.equal(result.exitCode, 7);
  }
  assert.equal(result.stderr, "fixture-error");
  assert.equal(result.stdout, "");
});

test("process-runner: handles process timeout gracefully", async () => {
  const runner = new NodeProcessRunner();

  const result = await runner.run({
    command: process.execPath,
    args: [fixturePath, "wait"],
    cwd: process.cwd(),
    timeoutMs: 50,
  });

  assert.equal(result.termination, "timed-out");
});

test("process-runner: handles external abort signal", async () => {
  const runner = new NodeProcessRunner();
  const abortController = new AbortController();

  const promise = runner.run({
    command: process.execPath,
    args: [fixturePath, "wait"],
    cwd: process.cwd(),
    timeoutMs: 5000,
    signal: abortController.signal,
  });

  setTimeout(() => abortController.abort(), 30);

  const result = await promise;
  assert.equal(result.termination, "aborted");
});

test("process-runner: terminates child and reports output-limit when exceeding 10MB", async () => {
  const runner = new NodeProcessRunner();

  const result = await runner.run({
    command: process.execPath,
    args: [fixturePath, "flood"],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.equal(result.termination, "output-limit");
});

test("process-runner: returns spawn-error for non-existent binary without rejecting", async () => {
  const runner = new NodeProcessRunner();

  const result = await runner.run({
    command: "non_existent_binary_12345_xyz",
    args: [],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.equal(result.termination, "spawn-error");
  if (result.termination === "spawn-error") {
    assert.ok(result.error.message.length > 0);
  }
});

test("process-runner: captures POSIX signals on non-Windows platform", { skip: process.platform === "win32" }, async () => {
  const runner = new NodeProcessRunner();

  const result = await runner.run({
    command: process.execPath,
    args: [fixturePath, "signal"],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.equal(result.termination, "signalled");
});
