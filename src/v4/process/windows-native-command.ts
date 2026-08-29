import fs from "node:fs";
import path from "node:path";

const SAFE_COMMAND_NAME = /^[A-Za-z0-9._-]+$/;
const NATIVE_EXTENSIONS = [".exe", ".com"] as const;
const NATIVE_NPM_SHIM_TARGET = /^"%dp0%(\\[^"\r\n]+\.exe)"\s+%\*\s*$/im;
const MODERN_NODE_EXE = /^SET\s+"NODE_EXE=%~dp0(\\[^"\r\n]+\.exe)"\s*$/im;
const MODERN_CLI_JS = /^SET\s+"(?:NPM|NPX)_CLI_JS=%~dp0(\\[^"\r\n]+\.js)"\s*$/im;
const MODERN_SHIM_CALL = /^"%NODE_EXE%"\s+"%(?:NPM|NPX)_CLI_JS%"\s+%\*\s*$/im;

export interface WindowsNativeInvocation {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isContained(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveContainedFile(pathDir: string, relativeTarget: string): string | undefined {
  const targetPath = path.resolve(pathDir, relativeTarget.replace(/^\\+/, ""));
  if (!isFile(targetPath)) return undefined;

  try {
    const realRoot = fs.realpathSync.native(pathDir);
    const realTarget = fs.realpathSync.native(targetPath);
    return isContained(realRoot, realTarget) ? realTarget : undefined;
  } catch {
    return undefined;
  }
}

function resolveNativeNpmShim(
  pathDir: string,
  command: string
): WindowsNativeInvocation | undefined {
  const shimPath = path.join(pathDir, `${command}.cmd`);
  if (!isFile(shimPath)) return undefined;

  let shimText: string;
  try {
    shimText = fs.readFileSync(shimPath, "utf-8");
  } catch {
    return undefined;
  }

  const targetMatch = shimText.match(NATIVE_NPM_SHIM_TARGET);
  if (targetMatch?.[1]) {
    const target = resolveContainedFile(pathDir, targetMatch[1]);
    return target ? { command: target, prefixArgs: [] } : undefined;
  }

  if (!MODERN_SHIM_CALL.test(shimText)) return undefined;
  const nodeMatch = shimText.match(MODERN_NODE_EXE);
  const cliMatch = shimText.match(MODERN_CLI_JS);
  if (!nodeMatch?.[1] || !cliMatch?.[1]) return undefined;

  const nodeExecutable = resolveContainedFile(pathDir, nodeMatch[1]);
  const cliScript = resolveContainedFile(pathDir, cliMatch[1]);
  return nodeExecutable && cliScript
    ? { command: nodeExecutable, prefixArgs: [cliScript] }
    : undefined;
}

export function resolveWindowsNativeInvocation(
  command: string,
  env: NodeJS.ProcessEnv
): WindowsNativeInvocation {
  if (process.platform !== "win32" || !SAFE_COMMAND_NAME.test(command)) {
    return { command, prefixArgs: [] };
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  for (const rawDir of pathValue.split(path.delimiter)) {
    const pathDir = rawDir.trim().replace(/^"|"$/g, "");
    if (!pathDir) continue;

    for (const extension of NATIVE_EXTENSIONS) {
      const nativePath = path.join(pathDir, `${command}${extension}`);
      if (isFile(nativePath)) {
        return { command: nativePath, prefixArgs: [] };
      }
    }

    const shimTarget = resolveNativeNpmShim(pathDir, command);
    if (shimTarget) return shimTarget;
  }

  return { command, prefixArgs: [] };
}
