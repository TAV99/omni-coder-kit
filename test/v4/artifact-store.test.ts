import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { FileArtifactStore } from "../../src/v4/storage/artifact-store";
import { asArtifactId, asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { ArtifactClaim } from "../../src/v4/contracts/artifact";

test("artifact-store: record and verify valid file", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-art-"));
  try {
    const store = new FileArtifactStore();
    const filePath = path.join(tmpdir, "test.txt");
    const content = "Hello Artifact Store\n";
    await fs.writeFile(filePath, content, "utf-8");

    const claim: ArtifactClaim = {
      artifactId: asArtifactId("art-1"),
      kind: "file",
      relativePath: "test.txt",
    };

    const record = await store.record({
      workspaceDir: tmpdir,
      runId: asRunId("run-1"),
      producerStepId: asStepId("step-1"),
      claim,
      recordedAt: "2026-08-20T10:00:00.000Z",
    });

    const expectedHash = crypto.createHash("sha256").update(content).digest("hex");
    assert.equal(record.sha256, expectedHash);
    assert.equal(record.sizeBytes, Buffer.byteLength(content));

    // Verify unchanged
    const verifySuccess = await store.verify({
      workspaceDir: tmpdir,
      record,
    });
    assert.deepEqual(verifySuccess, { valid: true });

    // Verify modified
    await fs.writeFile(filePath, "Modified content", "utf-8");
    const verifyModified = await store.verify({
      workspaceDir: tmpdir,
      record,
    });
    assert.deepEqual(verifyModified, {
      valid: false,
      reason: "checksum-mismatch",
    });

    // Verify missing
    await fs.rm(filePath);
    const verifyMissing = await store.verify({
      workspaceDir: tmpdir,
      record,
    });
    assert.deepEqual(verifyMissing, {
      valid: false,
      reason: "missing",
    });
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("artifact-store: rejects escaping paths", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-art-escape-"));
  try {
    const store = new FileArtifactStore();
    const claimEscape: ArtifactClaim = {
      artifactId: asArtifactId("art-2"),
      kind: "file",
      relativePath: "../secret.txt",
    };

    await assert.rejects(
      store.record({
        workspaceDir: tmpdir,
        runId: asRunId("run-1"),
        producerStepId: asStepId("step-1"),
        claim: claimEscape,
        recordedAt: "2026-08-20T10:00:00.000Z",
      })
    );
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});
