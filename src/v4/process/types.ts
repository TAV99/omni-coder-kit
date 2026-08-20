export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export type ProcessResult =
  | (ProcessOutput & {
      readonly termination: "exited";
      readonly exitCode: number;
      readonly signal: null;
    })
  | (ProcessOutput & {
      readonly termination: "signalled";
      readonly exitCode: null;
      readonly signal: NodeJS.Signals;
    })
  | (ProcessOutput & {
      readonly termination: "timed-out" | "aborted" | "output-limit";
      readonly exitCode: null;
      readonly signal: NodeJS.Signals | null;
    })
  | (ProcessOutput & {
      readonly termination: "spawn-error";
      readonly exitCode: null;
      readonly signal: null;
      readonly error: { readonly code: string; readonly message: string };
    });

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}
