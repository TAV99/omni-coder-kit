import fs from "node:fs";
import path from "node:path";

const SAFE_COMMAND_NAME = /^[A-Za-z0-9._-]+$/;
const NATIVE_EXTENSIONS = [".exe", ".com"] as const;
const NATIVE_NPM_SHIM_TARGET = /^"%dp0%(\\[^"\r\n]+\.exe)"\s+%\*\s*$/im;

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

function resolveNativeNpmShim(pathDir: string, command: string): string | undefined {
  const shimPath = path.join(pathDir, `${command}.cmd`);
  if (!isFile(shimPath)) return undefined;

  let shimText: string;
  try {
    shimText = fs.readFileSync(shimPath, "utf-8");
  } catch {
    return undefined;
  }

  const targetMatch = shimText.match(NATIVE_NPM_SHIM_TARGET);
  if (!targetMatch?.[1]) return undefined;

  const relativeTarget = targetMatch[1].replace(/^\\+/, "");
  const targetPath = path.resolve(pathDir, relativeTarget);
  if (!isFile(targetPath)) return undefined;

  try {
    const realRoot = fs.realpathSync.native(pathDir);
    const realTarget = fs.realpathSync.native(targetPath);
    return isContained(realRoot, realTarget) ? realTarget : undefined;
  } catch {
    return undefined;
  }
}

export function resolveWindowsNativeCommand(
  command: string,
  env: NodeJS.ProcessEnv
): string {
  if (process.platform !== "win32" || !SAFE_COMMAND_NAME.test(command)) {
    return command;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  for (const rawDir of pathValue.split(path.delimiter)) {
    const pathDir = rawDir.trim().replace(/^"|"$/g, "");
    if (!pathDir) continue;

    for (const extension of NATIVE_EXTENSIONS) {
      const nativePath = path.join(pathDir, `${command}${extension}`);
      if (isFile(nativePath)) {
        return nativePath;
      }
    }

    const shimTarget = resolveNativeNpmShim(pathDir, command);
    if (shimTarget) return shimTarget;
  }

  return command;
}
