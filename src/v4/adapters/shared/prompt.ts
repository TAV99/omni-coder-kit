import type { StepRequest } from "../../contracts/adapter";

export function renderAgentPrompt(request: StepRequest): string {
  const payload = {
    protocol: "omni-v4",
    executionId: request.operationId,
    stepId: request.stepId,
    phase: request.phase,
    workspaceDir: request.workspaceDir,
    task: request.prompt,
  };

  return (
    `[OMNI-V4 CONTROL PROTOCOL]\n` +
    `You are an automated coding agent performing a workflow step for Omni v4.\n` +
    `- Work ONLY within workspaceDir: "${request.workspaceDir}".\n` +
    `- Return EXACTLY ONE JSON result matching the required schema.\n` +
    `- Echo the exact executionId: "${request.operationId}".\n` +
    `- Use workspace-relative paths for all artifact claims (do NOT use absolute paths or '..').\n` +
    `- Set every evidence producerStepId to "${request.stepId}".\n` +
    `- Do NOT emit native metadata inside the model-authored structured result.\n\n` +
    `[TASK REQUEST]\n` +
    JSON.stringify(payload)
  );
}
