import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ArtifactClaim, ArtifactRecord } from "../contracts/artifact";
import type { RunId, StepId } from "../contracts/ids";
import { isSafeRelativePath } from "../contracts/artifact";

export interface ArtifactRecordInput {
  readonly workspaceDir: string;
  readonly runId: RunId;
  readonly producerStepId: StepId;
  readonly claim: ArtifactClaim;
  readonly recordedAt: string;
}

export interface ArtifactVerificationInput {
  readonly workspaceDir: string;
  readonly record: ArtifactRecord;
}

export type ArtifactVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: "missing" | "checksum-mismatch" | "path-escape" };

export interface ArtifactStore {
  record(input: ArtifactRecordInput): Promise<ArtifactRecord>;
  verify(input: ArtifactVerificationInput): Promise<ArtifactVerification>;
}

export class FileArtifactStore implements ArtifactStore {
  private async computeFileHashAndSize(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error(`Target path '${filePath}' is not a regular file`);
      }
      const hash = crypto.createHash("sha256");
      const stream = handle.createReadStream();
      for await (const chunk of stream) {
        hash.update(chunk);
      }
      return {
        sha256: hash.digest("hex").toLowerCase(),
        sizeBytes: stat.size,
      };
    } finally {
      await handle.close();
    }
  }

  private async resolveContainedPath(workspaceDir: string, relativePath: string): Promise<string> {
    if (!isSafeRelativePath(relativePath)) {
      throw new Error(`Unsafe relative path '${relativePath}'`);
    }

    const realWorkspace = await fs.realpath(workspaceDir);
    const resolvedPath = path.resolve(realWorkspace, relativePath);
    const realTarget = await fs.realpath(resolvedPath);

    const relative = path.relative(realWorkspace, realTarget);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path '${relativePath}' escapes workspace '${workspaceDir}'`);
    }

    return realTarget;
  }

  async record(input: ArtifactRecordInput): Promise<ArtifactRecord> {
    const targetFile = await this.resolveContainedPath(input.workspaceDir, input.claim.relativePath);
    const { sha256, sizeBytes } = await this.computeFileHashAndSize(targetFile);

    return {
      schemaVersion: 1,
      artifactId: input.claim.artifactId,
      runId: input.runId,
      producerStepId: input.producerStepId,
      kind: input.claim.kind,
      relativePath: input.claim.relativePath,
      sha256,
      sizeBytes,
      recordedAt: input.recordedAt,
    };
  }

  async verify(input: ArtifactVerificationInput): Promise<ArtifactVerification> {
    let targetFile: string;
    try {
      targetFile = await this.resolveContainedPath(input.workspaceDir, input.record.relativePath);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return { valid: false, reason: "missing" };
      }
      return { valid: false, reason: "path-escape" };
    }

    try {
      const { sha256, sizeBytes } = await this.computeFileHashAndSize(targetFile);
      if (sha256 !== input.record.sha256 || sizeBytes !== input.record.sizeBytes) {
        return { valid: false, reason: "checksum-mismatch" };
      }
      return { valid: true };
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return { valid: false, reason: "missing" };
      }
      return { valid: false, reason: "path-escape" };
    }
  }
}
