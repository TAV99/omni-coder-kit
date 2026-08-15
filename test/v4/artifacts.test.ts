import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ArtifactStorage } from "../../src/v4/storage/artifacts";
import type { ArtifactClaim } from "../../src/v4/contracts/artifact";
import { asArtifactId, asRunId, asStepId } from "../../src/v4/contracts/ids";
import crypto from "node:crypto";

test("ArtifactStorage calculates SHA-256 and size correctly", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-art-"));
  try {
    const storage = new ArtifactStorage(tmpdir);
    const content = "hello world";
    const testFile = path.join(tmpdir, "test.txt");
    await fs.writeFile(testFile, content);

    const claim: ArtifactClaim = {
      artifactId: asArtifactId("a1"),
      kind: "file",
      relativePath: "test.txt"
    };

    const record = await storage.store(claim, testFile, asRunId("r1"), asStepId("s1"));
    assert.equal(record.sizeBytes, Buffer.byteLength(content));
    assert.equal(record.sha256, crypto.createHash("sha256").update(content).digest("hex"));
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("ArtifactStorage rejects escaping paths", async () => {
  const storage = new ArtifactStorage("/safe/dir");
  
  const claim: ArtifactClaim = {
    artifactId: asArtifactId("a1"),
    kind: "file",
    relativePath: "test.txt"
  };

  await assert.rejects(
    storage.store(claim, "/etc/passwd", asRunId("r1"), asStepId("s1")),
    /attempting to escape run directory/
  );
});

test("ArtifactStorage rejects missing files", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-art2-"));
  try {
    const storage = new ArtifactStorage(tmpdir);
    const claim: ArtifactClaim = {
      artifactId: asArtifactId("a1"),
      kind: "file",
      relativePath: "missing.txt"
    };
    
    await assert.rejects(
      storage.store(claim, path.join(tmpdir, "missing.txt"), asRunId("r1"), asStepId("s1")),
      /ENOENT/
    );
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});
