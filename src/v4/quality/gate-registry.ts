import type {
  GateDefinition,
  GateId,
  RequirementId,
  RequirementRecord,
} from "../contracts/quality";
import type { QualityConfig } from "./config";
import { QualityError } from "./errors";
import { computeCanonicalSha256 } from "./evidence-bundle-store";

export class GateRegistry {
  private readonly config: QualityConfig;
  private readonly requirements: readonly RequirementRecord[];
  private readonly gatesById = new Map<GateId, GateDefinition>();
  private readonly gatesByReqId = new Map<RequirementId, GateDefinition[]>();
  private readonly requirementsById = new Map<RequirementId, RequirementRecord>();

  constructor(
    config: QualityConfig,
    requirements: readonly RequirementRecord[]
  ) {
    this.config = config;
    this.requirements = requirements;

    for (const req of requirements) {
      this.requirementsById.set(req.requirementId, req);
    }

    for (const gate of config.gates) {
      if (this.gatesById.has(gate.id)) {
        throw new QualityError(
          "QUALITY_CONFIG_INVALID",
          `Duplicate gate ID '${gate.id}' in registry`
        );
      }
      this.gatesById.set(gate.id, gate);

      for (const reqId of gate.requirementIds) {
        let list = this.gatesByReqId.get(reqId);
        if (!list) {
          list = [];
          this.gatesByReqId.set(reqId, list);
        }
        list.push(gate);
      }
    }

    // Validate dependencies
    for (const gate of config.gates) {
      for (const depId of gate.dependsOn) {
        if (!this.gatesById.has(depId)) {
          throw new QualityError(
            "QUALITY_CONFIG_INVALID",
            `Gate '${gate.id}' depends on unknown gate '${depId}'`
          );
        }
      }
    }
  }

  getGate(id: GateId): GateDefinition | undefined {
    return this.gatesById.get(id);
  }

  getAllGates(): readonly GateDefinition[] {
    return Array.from(this.gatesById.values());
  }

  getGatesForRequirement(reqId: RequirementId): readonly GateDefinition[] {
    return this.gatesByReqId.get(reqId) ?? [];
  }

  getMappedRequirements(): readonly RequirementId[] {
    return Array.from(this.gatesByReqId.keys());
  }

  getUnmappedHardRequirements(): readonly RequirementRecord[] {
    const unmapped: RequirementRecord[] = [];
    for (const req of this.requirementsById.values()) {
      if (req.testStrategy.kind === "hard") {
        const mappedGates = this.gatesByReqId.get(req.requirementId);
        if (!mappedGates || mappedGates.length === 0) {
          unmapped.push(req);
        }
      }
    }
    return unmapped;
  }

  getRequirement(id: RequirementId): RequirementRecord | undefined {
    return this.requirementsById.get(id);
  }

  getAllRequirements(): readonly RequirementRecord[] {
    return Array.from(this.requirementsById.values());
  }

  getConfig(): QualityConfig {
    return this.config;
  }

  getConfigHash(): string {
    return computeCanonicalSha256(this.config);
  }

  getRequirements(): readonly RequirementRecord[] {
    return this.requirements;
  }

  getRequirementsHash(): string {
    return computeCanonicalSha256(this.requirements);
  }
}
