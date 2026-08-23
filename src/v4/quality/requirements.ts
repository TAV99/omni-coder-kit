import {
  asRequirementId,
  type RequirementRecord,
} from "../contracts/quality";
import { QualityError } from "./errors";

const REQUIREMENT_LINE_REGEX = /^-\s*\[([ x!])\]\s*([A-Za-z0-9_-]+)\s*\|\s*(.*?)\s*\|\s*test:\s*(.*)$/;

export function loadRequirements(markdown: string): readonly RequirementRecord[] {
  const records: RequirementRecord[] = [];
  const seenIds = new Set<string>();

  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine) {
      continue;
    }
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    // Must start with - [
    if (!trimmed.startsWith("- [")) {
      continue;
    }

    const match = trimmed.match(REQUIREMENT_LINE_REGEX);
    if (!match) {
      throw new QualityError(
        "REQUIREMENTS_INVALID",
        `Malformed requirement line at line ${i + 1}: ${trimmed}`
      );
    }

    const rawId = match[2];
    const rawText = match[3];
    const rawTest = match[4];

    if (!rawId || !rawText || !rawTest) {
      throw new QualityError(
        "REQUIREMENTS_INVALID",
        `Requirement line contains empty fields at line ${i + 1}: ${trimmed}`
      );
    }

    const reqId = rawId.trim();
    const text = rawText.trim();
    const testStrategyText = rawTest.trim();

    if (!reqId || !text || !testStrategyText) {
      throw new QualityError(
        "REQUIREMENTS_INVALID",
        `Requirement line contains empty fields at line ${i + 1}: ${trimmed}`
      );
    }

    if (seenIds.has(reqId)) {
      throw new QualityError(
        "REQUIREMENTS_INVALID",
        `Duplicate requirement ID '${reqId}' at line ${i + 1}`
      );
    }
    seenIds.add(reqId);

    const testStrategy =
      testStrategyText === "agent"
        ? ({ kind: "agent" } as const)
        : ({ kind: "hard", sourceText: testStrategyText } as const);

    records.push({
      requirementId: asRequirementId(reqId),
      text,
      testStrategy,
    });
  }

  return records;
}
