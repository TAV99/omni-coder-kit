import path from "node:path";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import {
  BenchmarkManifestSchema,
  type BenchmarkManifest,
} from "./contracts";
import { QualityError } from "../quality/errors";

export function isBenchmarkPathContained(targetPath: string, rootDir: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, targetPath);
  const isWin = process.platform === "win32";
  const norm = (p: string) => (isWin ? p.toLowerCase() : p);

  // 1. Lexical check
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return false;
  }

  // 2. Realpath check if root exists
  try {
    if (syncFs.existsSync(resolvedRoot)) {
      const realRoot = syncFs.realpathSync(resolvedRoot);
      const normRealRoot = norm(realRoot);

      if (syncFs.existsSync(resolvedTarget)) {
        const realTarget = syncFs.realpathSync(resolvedTarget);
        const normRealTarget = norm(realTarget);
        if (
          normRealTarget !== normRealRoot &&
          !normRealTarget.startsWith(normRealRoot + (normRealRoot.endsWith(path.sep) ? "" : path.sep))
        ) {
          return false;
        }
      } else {
        let curr = path.dirname(resolvedTarget);
        while (curr.length >= resolvedRoot.length) {
          if (syncFs.existsSync(curr)) {
            const realCurr = syncFs.realpathSync(curr);
            const normRealCurr = norm(realCurr);
            if (
              normRealCurr !== normRealRoot &&
              !normRealCurr.startsWith(normRealRoot + (normRealRoot.endsWith(path.sep) ? "" : path.sep))
            ) {
              return false;
            }
            break;
          }
          const parent = path.dirname(curr);
          if (parent === curr) break;
          curr = parent;
        }
      }
    }
  } catch {
    return false;
  }

  return true;
}

export async function loadBenchmarkManifest(
  repoRoot: string,
  customManifestPath?: string
): Promise<BenchmarkManifest> {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedManifestPath = path.resolve(
    resolvedRoot,
    customManifestPath ?? path.join("benchmarks", "v4", "manifest.json")
  );

  if (!isBenchmarkPathContained(resolvedManifestPath, resolvedRoot)) {
    throw new QualityError(
      "BENCHMARK_MANIFEST_INVALID",
      `Benchmark manifest path escapes repository root: ${resolvedManifestPath}`
    );
  }

  let rawContent: string;
  try {
    rawContent = await fs.readFile(resolvedManifestPath, "utf-8");
  } catch (err: unknown) {
    const isErrno = (e: unknown): e is NodeJS.ErrnoException => e instanceof Error;
    const errCode = isErrno(err) ? err.code : undefined;
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errCode === "ENOENT") {
      throw new QualityError(
        "BENCHMARK_MANIFEST_INVALID",
        `Benchmark manifest not found at '${resolvedManifestPath}'`
      );
    }
    throw new QualityError(
      "BENCHMARK_MANIFEST_INVALID",
      `Failed to read benchmark manifest: ${errMsg}`
    );
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawContent);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new QualityError(
      "BENCHMARK_MANIFEST_INVALID",
      `Invalid JSON in benchmark manifest: ${errMsg}`
    );
  }

  const parseRes = BenchmarkManifestSchema.safeParse(rawJson);
  if (!parseRes.success) {
    throw new QualityError(
      "BENCHMARK_MANIFEST_INVALID",
      `Benchmark manifest schema violation: ${parseRes.error.message}`
    );
  }

  const manifest = parseRes.data;

  // Validate case ID uniqueness and path containment
  const seenCaseIds = new Set<string>();
  for (const c of manifest.cases) {
    if (seenCaseIds.has(c.id)) {
      throw new QualityError(
        "BENCHMARK_MANIFEST_INVALID",
        `Duplicate benchmark case ID '${c.id}'`
      );
    }
    seenCaseIds.add(c.id);

    if (c.fixturePath) {
      const resolvedFixture = path.resolve(resolvedRoot, c.fixturePath);
      if (!isBenchmarkPathContained(resolvedFixture, resolvedRoot)) {
        throw new QualityError(
          "BENCHMARK_MANIFEST_INVALID",
          `Benchmark case '${c.id}' fixturePath '${c.fixturePath}' resolves outside repository root`
        );
      }
    }

    if (c.repositoryPath) {
      const resolvedRepo = path.resolve(resolvedRoot, c.repositoryPath);
      if (!isBenchmarkPathContained(resolvedRepo, resolvedRoot)) {
        throw new QualityError(
          "BENCHMARK_MANIFEST_INVALID",
          `Benchmark case '${c.id}' repositoryPath '${c.repositoryPath}' resolves outside repository root`
        );
      }
    }

    if (c.enabled && c.projectKind !== "omni" && c.projectKind !== "fixture" && !c.repositoryPath) {
      throw new QualityError(
        "BENCHMARK_MANIFEST_INVALID",
        `Enabled benchmark case '${c.id}' with projectKind '${c.projectKind}' requires repositoryPath`
      );
    }
  }

  return manifest;
}
