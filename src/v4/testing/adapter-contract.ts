import test from "node:test";
import assert from "node:assert/strict";
import type { AgentAdapter, StepRequest } from "../contracts/adapter";
import { StepResultSchema } from "../contracts/step-result";
import type { ProcessRunner, ProcessRequest, ProcessResult } from "../process/types";
import { asRunId, asStepId } from "../contracts/ids";

export interface AdapterContractOptions {
  readonly elevatedFlag: string;
}

export type AdapterFactory = (runner: ProcessRunner) => Promise<AgentAdapter>;

export function runAdapterContractSuite(
  hostId: string,
  factory: AdapterFactory,
  options: AdapterContractOptions
) {
  test(`${hostId} adapter contract: probe returns valid metadata and forwards signal`, async () => {
    let probeSignalReceived = false;
    const runner: ProcessRunner = {
      async run(req: ProcessRequest): Promise<ProcessResult> {
        if (req.signal) {
          probeSignalReceived = true;
        }
        return {
          stdout: `${hostId} version 1.0.0`,
          stderr: "",
          durationMs: 1,
          termination: "exited",
          exitCode: 0,
          signal: null,
        };
      },
    };

    const adapter = await factory(runner);
    const abortCtrl = new AbortController();
    const probe = await adapter.probe(abortCtrl.signal);
    assert.equal(probe.adapterId, hostId);
    assert.equal(typeof probe.available, "boolean");
    assert.ok(Array.isArray(probe.capabilities));
    assert.ok(probeSignalReceived);
  });

  test(`${hostId} adapter contract: safe mode argv never contains elevated flag`, async () => {
    let executedArgs: readonly string[] = [];
    const runner: ProcessRunner = {
      async run(req: ProcessRequest): Promise<ProcessResult> {
        executedArgs = req.args;
        return {
          stdout: "",
          stderr: "",
          durationMs: 5,
          termination: "exited",
          exitCode: 0,
          signal: null,
        };
      },
    };

    const adapter = await factory(runner);
    const dummyReq: StepRequest = {
      runId: asRunId("run-1"),
      stepId: asStepId("step-1"),
      phase: "INTAKE",
      operationId: "op-safe",
      workspaceDir: process.cwd(),
      prompt: "safe prompt",
      requiredCapabilities: ["workspace.read"],
      sideEffect: "read-only",
      timeoutMs: 60000,
    };

    await adapter.execute(dummyReq, {
      signal: new AbortController().signal,
      elevatedPermissions: false,
    });

    assert.ok(
      !executedArgs.includes(options.elevatedFlag),
      `Safe mode must not contain elevated flag '${options.elevatedFlag}'`
    );
  });

  test(`${hostId} adapter contract: elevated mode contains elevated flag exactly once`, async () => {
    let executedArgs: readonly string[] = [];
    const runner: ProcessRunner = {
      async run(req: ProcessRequest): Promise<ProcessResult> {
        executedArgs = req.args;
        return {
          stdout: "",
          stderr: "",
          durationMs: 5,
          termination: "exited",
          exitCode: 0,
          signal: null,
        };
      },
    };

    const adapter = await factory(runner);
    const dummyReq: StepRequest = {
      runId: asRunId("run-1"),
      stepId: asStepId("step-1"),
      phase: "INTAKE",
      operationId: "op-elevated",
      workspaceDir: process.cwd(),
      prompt: "elevated prompt",
      requiredCapabilities: ["workspace.read"],
      sideEffect: "workspace-write",
      timeoutMs: 60000,
    };

    await adapter.execute(dummyReq, {
      signal: new AbortController().signal,
      elevatedPermissions: true,
    });

    const occurrences = executedArgs.filter((arg) => arg === options.elevatedFlag).length;
    assert.equal(
      occurrences,
      1,
      `Elevated mode must contain '${options.elevatedFlag}' exactly once, found ${occurrences}`
    );
  });

  test(`${hostId} adapter contract: non-zero exit returns failure`, async () => {
    const runner: ProcessRunner = {
      async run(req: ProcessRequest): Promise<ProcessResult> {
        return {
          stdout: "",
          stderr: "CLI error",
          durationMs: 10,
          termination: "exited",
          exitCode: 1,
          signal: null,
        };
      },
    };

    const adapter = await factory(runner);
    const dummyReq: StepRequest = {
      runId: asRunId("run-1"),
      stepId: asStepId("step-1"),
      phase: "INTAKE",
      operationId: "op-1",
      workspaceDir: process.cwd(),
      prompt: "test",
      requiredCapabilities: ["workspace.read"],
      sideEffect: "read-only",
      timeoutMs: 60000,
    };

    const outcome = await adapter.execute(dummyReq, {
      signal: new AbortController().signal,
      elevatedPermissions: false,
    });

    const parsed = StepResultSchema.parse(outcome);
    assert.equal(parsed.status, "failed");
    assert.equal(parsed.executionId, "op-1");
  });

  test(`${hostId} adapter contract: cancellation is idempotent`, async () => {
    const runner: ProcessRunner = {
      async run(): Promise<ProcessResult> {
        return {
          stdout: "",
          stderr: "",
          durationMs: 1,
          termination: "exited",
          exitCode: 0,
          signal: null,
        };
      },
    };

    const adapter = await factory(runner);
    await adapter.cancel("non-existent-exec-id");
    await adapter.cancel("non-existent-exec-id");
  });
}
