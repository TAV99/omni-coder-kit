import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { QualityError } from "../quality/errors";

export const ExternalCaseBindingSchema = z
  .object({
    repositoryRoot: z
      .string()
      .min(1)
      .refine((value) => path.isAbsolute(value), "repositoryRoot must be absolute"),
    revision: z.string().regex(/^[0-9a-f]{40}$/i, "revision must be a full Git SHA"),
    dependencyPolicy: z.enum(["clean-install", "existing-lockfile"]),
    toolchain: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();

export const ExternalBindingFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    cases: z.record(
      z.string().regex(/^[A-Za-z0-9_-]+$/, "binding case ID must be path-safe"),
      ExternalCaseBindingSchema
    ),
  })
  .strict();

export type ExternalCaseBinding = z.infer<typeof ExternalCaseBindingSchema>;
export type ExternalBindingFile = z.infer<typeof ExternalBindingFileSchema>;

export interface ExternalBindingContract {
  readonly requiredDependencyPolicy?: ExternalCaseBinding["dependencyPolicy"] | undefined;
  readonly requiredToolchain?: Readonly<Record<string, string>> | undefined;
}

function invalidBinding(message: string): QualityError {
  return new QualityError(
    "BENCHMARK_WORKSPACE_UNSAFE",
    `[BENCHMARK_EXTERNAL_BINDING_INVALID] ${message}`
  );
}

export async function loadExternalBindings(bindingPath: string): Promise<ExternalBindingFile> {
  let raw: string;
  try {
    raw = await fs.readFile(path.resolve(bindingPath), "utf-8");
  } catch {
    throw invalidBinding("Binding file is missing or unreadable");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidBinding("Binding file is not valid JSON");
  }

  const parsed = ExternalBindingFileSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidBinding("Binding file does not match schema version 1");
  }
  return parsed.data;
}

export function requireExternalCaseBinding(
  bindings: ExternalBindingFile,
  caseId: string
): ExternalCaseBinding {
  const binding = bindings.cases[caseId];
  if (!binding) {
    throw new QualityError(
      "BENCHMARK_WORKSPACE_UNSAFE",
      `[BENCHMARK_EXTERNAL_BINDING_MISSING] No binding exists for case '${caseId}'`
    );
  }
  return binding;
}

export function enforceExternalBindingContract(
  binding: ExternalCaseBinding,
  contract: ExternalBindingContract
): void {
  if (
    contract.requiredDependencyPolicy !== undefined &&
    binding.dependencyPolicy !== contract.requiredDependencyPolicy
  ) {
    throw invalidBinding(
      "[BENCHMARK_EXTERNAL_DEPENDENCY_POLICY_MISMATCH] Binding dependency policy does not match the case contract"
    );
  }

  for (const [name, requiredValue] of Object.entries(contract.requiredToolchain ?? {})) {
    if (binding.toolchain?.[name] !== requiredValue) {
      throw invalidBinding(
        `[BENCHMARK_EXTERNAL_TOOLCHAIN_MISMATCH] Binding toolchain metadata does not match the case contract for '${name}'`
      );
    }
  }
}
