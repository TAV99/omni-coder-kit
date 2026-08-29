import crypto from "node:crypto";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExternalCaseBinding } from "./external-binding";
import { QualityError } from "../quality/errors";

export interface ExternalSourceMetadata {
  readonly repositoryRoot: string;
  readonly revision: string;
  readonly isDirty: false;
  readonly trackedFileCount: number;
  readonly treeSha256: string;
}

interface WorkspaceSnapshotEntry {
  readonly relativePath: string;
  readonly sha256: string;
  readonly content: Buffer;
}

export interface WorkspaceSnapshot {
  readonly root: string;
  readonly entries: readonly WorkspaceSnapshotEntry[];
}

export interface WorkspaceDiffEvidence {
  readonly modifiedFiles: readonly string[];
  readonly patchSha256: string;
  readonly secretFindings: readonly { readonly path: string; readonly ruleId: string }[];
}

export class WorkspaceDiffViolation extends QualityError {
  readonly evidence: WorkspaceDiffEvidence;

  constructor(tag: string, message: string, evidence: WorkspaceDiffEvidence) {
    super("BENCHMARK_WORKSPACE_UNSAFE", `[${tag}] ${message}`);
    this.evidence = evidence;
  }
}

interface GitTreeEntry {
  readonly mode: string;
  readonly objectId: string;
  readonly relativePath: string;
  readonly content: Buffer;
}

function externalError(tag: string, message: string): QualityError {
  return new QualityError("BENCHMARK_WORKSPACE_UNSAFE", `[${tag}] ${message}`);
}

function gitBuffer(repositoryRoot: string, args: readonly string[]): Buffer {
  try {
    return execFileSync("git", [...args], {
      cwd: repositoryRoot,
      encoding: "buffer",
      windowsHide: true,
      shell: false,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw externalError(
      "BENCHMARK_EXTERNAL_SOURCE_INVALID",
      "Git repository inspection failed"
    );
  }
}

function gitText(repositoryRoot: string, args: readonly string[]): string {
  return gitBuffer(repositoryRoot, args).toString("utf-8").trim();
}

function isPortableRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    !relativePath.includes("\\") &&
    !relativePath.includes(":") &&
    !path.posix.isAbsolute(relativePath) &&
    !relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function isUnsafeTrackedPath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  if (segments.some((segment) => [".git", ".omni", "node_modules", "dist", "coverage"].includes(segment))) {
    return true;
  }
  if (basename.startsWith(".env") && basename !== ".env.example") {
    return true;
  }
  return basename === "credentials.json" || basename.endsWith(".pem") || basename.endsWith(".key");
}

function loadPinnedTree(repositoryRoot: string, revision: string): readonly GitTreeEntry[] {
  const raw = gitBuffer(repositoryRoot, ["ls-tree", "-r", "-z", revision]);
  const records = raw.toString("utf-8").split("\0").filter(Boolean);
  const entries: GitTreeEntry[] = [];

  for (const record of records) {
    const tabIndex = record.indexOf("\t");
    const header = tabIndex >= 0 ? record.slice(0, tabIndex) : "";
    const relativePath = tabIndex >= 0 ? record.slice(tabIndex + 1) : "";
    const [mode, type, objectId] = header.split(" ");
    if (!mode || type !== "blob" || !objectId || !isPortableRelativePath(relativePath)) {
      throw externalError(
        "BENCHMARK_EXTERNAL_TRACKED_PATH_UNSAFE",
        "Pinned tree contains an unsupported entry"
      );
    }
    if (mode === "120000" || isUnsafeTrackedPath(relativePath)) {
      throw externalError(
        "BENCHMARK_EXTERNAL_TRACKED_PATH_UNSAFE",
        `Pinned tree contains unsafe tracked path '${relativePath}'`
      );
    }
    entries.push({
      mode,
      objectId,
      relativePath,
      content: gitBuffer(repositoryRoot, ["show", `${revision}:${relativePath}`]),
    });
  }

  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function metadataFor(repositoryRoot: string, revision: string, entries: readonly GitTreeEntry[]): ExternalSourceMetadata {
  const hash = crypto.createHash("sha256");
  for (const entry of entries) {
    const contentHash = crypto.createHash("sha256").update(entry.content).digest("hex");
    hash.update(entry.relativePath).update("\0").update(contentHash).update("\0");
  }
  return {
    repositoryRoot,
    revision,
    isDirty: false,
    trackedFileCount: entries.length,
    treeSha256: hash.digest("hex"),
  };
}

export function inspectExternalRepository(binding: ExternalCaseBinding): ExternalSourceMetadata {
  const repositoryRoot = syncFs.realpathSync(path.resolve(binding.repositoryRoot));
  if (!syncFs.statSync(repositoryRoot).isDirectory()) {
    throw externalError("BENCHMARK_EXTERNAL_SOURCE_INVALID", "Repository root is not a directory");
  }

  const gitTopLevel = syncFs.realpathSync(
    path.resolve(gitText(repositoryRoot, ["rev-parse", "--show-toplevel"]))
  );
  if (path.relative(repositoryRoot, gitTopLevel) !== "" || path.relative(gitTopLevel, repositoryRoot) !== "") {
    throw externalError(
      "BENCHMARK_EXTERNAL_ROOT_MISMATCH",
      "Binding repositoryRoot must be the Git worktree root"
    );
  }

  const head = gitText(repositoryRoot, ["rev-parse", "HEAD"]).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw externalError("BENCHMARK_EXTERNAL_SOURCE_INVALID", "Repository has no valid HEAD commit");
  }
  if (head !== binding.revision.toLowerCase()) {
    throw externalError(
      "BENCHMARK_EXTERNAL_REVISION_MISMATCH",
      "Repository HEAD does not match the pinned binding revision"
    );
  }

  const status = gitText(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.length > 0) {
    throw externalError("BENCHMARK_EXTERNAL_SOURCE_DIRTY", "Repository worktree is not clean");
  }

  const entries = loadPinnedTree(repositoryRoot, head);
  return metadataFor(repositoryRoot, head, entries);
}

export async function stagePinnedTrackedTree(
  binding: ExternalCaseBinding,
  destination: string
): Promise<ExternalSourceMetadata> {
  const metadata = inspectExternalRepository(binding);
  const entries = loadPinnedTree(metadata.repositoryRoot, metadata.revision);
  const destinationRoot = path.resolve(destination);
  await fs.mkdir(destinationRoot, { recursive: true });

  for (const entry of entries) {
    const outputPath = path.resolve(destinationRoot, ...entry.relativePath.split("/"));
    const relativeOutput = path.relative(destinationRoot, outputPath);
    if (relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) {
      throw externalError(
        "BENCHMARK_EXTERNAL_TRACKED_PATH_UNSAFE",
        "Tracked path escapes the owned destination"
      );
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, entry.content);
  }

  return metadataFor(metadata.repositoryRoot, metadata.revision, entries);
}

const SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
]);

function shouldIgnoreSnapshotPath(relativePath: string, isDirectory: boolean): boolean {
  const segments = relativePath.toLowerCase().split("/");
  if (isDirectory && SNAPSHOT_IGNORED_DIRECTORIES.has(segments.at(-1) ?? "")) {
    return true;
  }
  return false;
}

export async function captureWorkspaceSnapshot(root: string): Promise<WorkspaceSnapshot> {
  const canonicalRoot = await fs.realpath(path.resolve(root));
  const entries: WorkspaceSnapshotEntry[] = [];

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      if (shouldIgnoreSnapshotPath(relativePath, child.isDirectory())) continue;

      const absolutePath = path.join(directory, child.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw externalError(
          "BENCHMARK_EXTERNAL_SNAPSHOT_UNSAFE",
          `Workspace contains unsupported symbolic link '${relativePath}'`
        );
      }
      if (stat.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (stat.isFile()) {
        const content = await fs.readFile(absolutePath);
        entries.push({
          relativePath,
          sha256: crypto.createHash("sha256").update(content).digest("hex"),
          content,
        });
      }
    }
  }

  await walk(canonicalRoot, "");
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { root: canonicalRoot, entries };
}

function isAllowedMutation(relativePath: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some(
    (allowed) => relativePath === allowed.replace(/\\/g, "/").replace(/\/+$/, "")
  );
}

const SECRET_RULES = [
  {
    id: "assigned-credential",
    pattern: /["']?(?:api[_-]?key|secret|token|passwd|password)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  },
] as const;

export function compareWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  allowedPaths: readonly string[]
): WorkspaceDiffEvidence {
  const beforeMap = new Map(before.entries.map((entry) => [entry.relativePath, entry]));
  const afterMap = new Map(after.entries.map((entry) => [entry.relativePath, entry]));
  const allPaths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  const changes: Array<{
    readonly kind: "created" | "modified" | "deleted";
    readonly path: string;
    readonly beforeSha256: string | null;
    readonly afterSha256: string | null;
  }> = [];
  const secretFindings: Array<{ readonly path: string; readonly ruleId: string }> = [];
  const outsidePaths: string[] = [];

  for (const relativePath of allPaths) {
    const prior = beforeMap.get(relativePath);
    const current = afterMap.get(relativePath);
    if (prior?.sha256 === current?.sha256) continue;
    const kind = prior ? (current ? "modified" : "deleted") : "created";
    changes.push({
      kind,
      path: relativePath,
      beforeSha256: prior?.sha256 ?? null,
      afterSha256: current?.sha256 ?? null,
    });
    if (!isAllowedMutation(relativePath, allowedPaths)) {
      outsidePaths.push(relativePath);
    }

    if (current && current.content.includes(0) === false) {
      const text = current.content.toString("utf-8");
      for (const rule of SECRET_RULES) {
        if (rule.pattern.test(text)) {
          secretFindings.push({ path: relativePath, ruleId: rule.id });
        }
      }
    }
  }

  const evidence: WorkspaceDiffEvidence = {
    modifiedFiles: changes.map((change) => change.path),
    patchSha256: crypto
      .createHash("sha256")
      .update(JSON.stringify(changes))
      .digest("hex"),
    secretFindings,
  };

  if (outsidePaths.length > 0) {
    throw new WorkspaceDiffViolation(
      "BENCHMARK_EXTERNAL_DIFF_SCOPE",
      `Workspace mutation is outside the allowed scope at '${outsidePaths[0]}'`,
      evidence
    );
  }

  if (secretFindings.length > 0) {
    throw new WorkspaceDiffViolation(
      "BENCHMARK_EXTERNAL_SECRET_DETECTED",
      `Credential-like content detected in '${secretFindings[0]!.path}' by rule '${secretFindings[0]!.ruleId}'`,
      evidence
    );
  }
  return evidence;
}
