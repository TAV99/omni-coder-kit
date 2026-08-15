import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ArtifactClaim, ArtifactRecord } from "../contracts/artifact";
import type { RunId, StepId } from "../contracts/ids";

export class ArtifactStorage {
  constructor(public readonly runDirectory: string) {}

  async store(claim: ArtifactClaim, absolutePath: string, runId: RunId, producerStepId: StepId): Promise<ArtifactRecord> {
    // Basic validation of absolutePath against runDirectory (escaping)
    const normalizedAbsPath = path.normalize(absolutePath);
    const normalizedRunDir = path.normalize(this.runDirectory);

    if (!normalizedAbsPath.startsWith(normalizedRunDir)) {
      throw new Error(`Artifact path ${absolutePath} is attempting to escape run directory ${this.runDirectory}`);
    }

    const stat = await fs.stat(normalizedAbsPath);
    if (!stat.isFile()) {
      throw new Error(`Artifact path ${absolutePath} is not a file`);
    }

    const sizeBytes = stat.size;

    const hash = crypto.createHash("sha256");
    const fileHandle = await fs.open(normalizedAbsPath, "r");
    try {
      const stream = fileHandle.createReadStream();
      for await (const chunk of stream) {
        hash.update(chunk);
      }
    } finally {
      await fileHandle.close();
    }
    const sha256 = hash.digest("hex");

    return {
      schemaVersion: 1,
      artifactId: claim.artifactId,
      runId,
      producerStepId,
      kind: claim.kind,
      relativePath: claim.relativePath,
      sha256,
      sizeBytes,
      recordedAt: new Date().toISOString(),
    };
  }
}
