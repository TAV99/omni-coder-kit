export interface HostInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly resultFile?: string;
}
