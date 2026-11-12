import { PromptRegistry, computePromptSha256 } from "@software-factory/adapter-sdk";
import {
  type PromptTemplateSpec,
  type StructuredJsonSchema,
} from "@software-factory/shared-types";

export const STAGE1_DISCOVERY_PROMPT_ID = "stage1.discovery.extract";
export const STAGE1_DISCOVERY_PROMPT_VERSION = "1.0.0";

export const STAGE2_REQUIREMENTS_PROMPT_ID = "stage2.requirements.generate";
export const STAGE2_REQUIREMENTS_PROMPT_VERSION = "1.0.0";

export const STAGE3_ARCHITECTURE_PROMPT_ID = "stage3.architecture.design";
export const STAGE3_ARCHITECTURE_PROMPT_VERSION = "1.0.0";

export const STAGE4_CONSISTENCY_CHECK_PROMPT_ID = "stage4.consistency.check";
export const STAGE4_CONSISTENCY_CHECK_PROMPT_VERSION = "1.0.0";

export const STAGE7_PLANNING_PROMPT_ID = "stage7.planning.decompose";
export const STAGE7_PLANNING_PROMPT_VERSION = "1.0.0";

export const STAGE1_DISCOVERY_OUTPUT_SCHEMA: StructuredJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "facts", "assumptions", "recommendations"],
  properties: {
    summary: { type: "string", minLength: 1 },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "statement", "rationale"],
        properties: {
          title: { type: "string", minLength: 1 },
          statement: { type: "string", minLength: 1 },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
    assumptions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "statement", "rationale", "clarification_question"],
        properties: {
          title: { type: "string", minLength: 1 },
          statement: { type: "string", minLength: 1 },
          rationale: { type: "string", minLength: 1 },
          clarification_question: { type: "string", minLength: 1 },
        },
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "statement", "rationale", "clarification_question"],
        properties: {
          title: { type: "string", minLength: 1 },
          statement: { type: "string", minLength: 1 },
          rationale: { type: "string", minLength: 1 },
          clarification_question: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

const STAGE2_REQUIREMENT_ITEM_SCHEMA: StructuredJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "req_id",
    "title",
    "description",
    "priority",
    "source_discovery_item_ids",
    "acceptance_criteria",
  ],
  properties: {
    req_id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    priority: { type: "string", enum: ["MUST", "SHOULD", "COULD"] },
    source_discovery_item_ids: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    acceptance_criteria: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ac_id", "given", "when", "then"],
        properties: {
          ac_id: { type: "string", minLength: 1 },
          given: { type: "string", minLength: 1 },
          when: { type: "string", minLength: 1 },
          then: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

export const STAGE2_REQUIREMENTS_OUTPUT_SCHEMA: StructuredJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prd", "srs"],
  properties: {
    prd: {
      type: "object",
      additionalProperties: false,
      required: ["product_vision", "target_personas", "goals", "non_goals"],
      properties: {
        product_vision: { type: "string", minLength: 1 },
        target_personas: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        goals: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        non_goals: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    srs: {
      type: "object",
      additionalProperties: false,
      required: ["functional_requirements", "non_functional_requirements"],
      properties: {
        functional_requirements: {
          type: "array",
          minItems: 1,
          items: STAGE2_REQUIREMENT_ITEM_SCHEMA,
        },
        non_functional_requirements: {
          type: "array",
          items: STAGE2_REQUIREMENT_ITEM_SCHEMA,
        },
      },
    },
  },
};

export const STAGE3_ARCHITECTURE_OUTPUT_SCHEMA: StructuredJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["architecture", "database_erd", "api_spec", "security_design", "adrs"],
  properties: {
    architecture: {
      type: "object",
      additionalProperties: false,
      required: ["overview", "components"],
      properties: {
        overview: { type: "string", minLength: 1 },
        components: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["component_id", "name", "responsibility", "requirement_ids"],
            properties: {
              component_id: { type: "string", minLength: 1 },
              name: { type: "string", minLength: 1 },
              responsibility: { type: "string", minLength: 1 },
              requirement_ids: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
    database_erd: {
      type: "object",
      additionalProperties: false,
      required: ["entities"],
      properties: {
        entities: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "entity_name",
              "primary_key",
              "columns",
              "foreign_keys",
              "rls_tier",
              "requirement_ids",
            ],
            properties: {
              entity_name: { type: "string", minLength: 1 },
              primary_key: { type: "string", minLength: 1 },
              columns: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
              foreign_keys: { type: "array", items: { type: "string", minLength: 1 } },
              rls_tier: {
                type: "string",
                enum: ["TIER_1", "TIER_2", "TIER_3", "TIER_4"],
              },
              requirement_ids: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
    api_spec: {
      type: "object",
      additionalProperties: false,
      required: ["endpoints"],
      properties: {
        endpoints: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["method", "path", "summary", "auth_role", "requirement_ids"],
            properties: {
              method: {
                type: "string",
                enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
              },
              path: { type: "string", minLength: 1 },
              summary: { type: "string", minLength: 1 },
              auth_role: { type: "string", minLength: 1 },
              requirement_ids: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
    security_design: {
      type: "object",
      additionalProperties: false,
      required: ["threat_controls"],
      properties: {
        threat_controls: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["threat_id", "threat", "mitigation", "requirement_ids"],
            properties: {
              threat_id: { type: "string", minLength: 1 },
              threat: { type: "string", minLength: 1 },
              mitigation: { type: "string", minLength: 1 },
              requirement_ids: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
    // Keep adrs minItems unbounded here so Stage 4 CHK-04 catches empty ADR proposals cleanly (M6A-AC6).
    adrs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "adr_id",
          "title",
          "status",
          "context",
          "decision",
          "consequences",
          "requirement_ids",
        ],
        properties: {
          adr_id: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["PROPOSED", "ACCEPTED"] },
          context: { type: "string", minLength: 1 },
          decision: { type: "string", minLength: 1 },
          consequences: { type: "string", minLength: 1 },
          requirement_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
  },
};

export const STAGE4_CONSISTENCY_CHECK_OUTPUT_SCHEMA: StructuredJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "pipeline_session_id",
    "passed",
    "checks",
    "blocking_errors",
    "referenced_stage1_artifact_id",
    "referenced_stage2_artifact_id",
    "referenced_stage3_artifact_id",
    "checked_at",
  ],
  properties: {
    pipeline_session_id: { type: "string", minLength: 1 },
    passed: { type: "boolean" },
    checks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["check_id", "name", "passed", "severity", "details", "affected_ids"],
        properties: {
          check_id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          passed: { type: "boolean" },
          severity: { type: "string", enum: ["ERROR", "WARNING"] },
          details: { type: "string", minLength: 1 },
          affected_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
    blocking_errors: { type: "array", items: { type: "string" } },
    referenced_stage1_artifact_id: { type: "string" },
    referenced_stage2_artifact_id: { type: "string" },
    referenced_stage3_artifact_id: { type: "string" },
    checked_at: { type: "string", minLength: 1 },
  },
};

export const STAGE7_PLANNING_OUTPUT_SCHEMA: StructuredJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["milestones", "epics", "stories", "tasks", "planning_notes"],
  properties: {
    milestones: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["milestone_key", "title", "description"],
        properties: {
          milestone_key: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
        },
      },
    },
    epics: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["epic_key", "milestone_key", "title", "description"],
        properties: {
          epic_key: { type: "string", minLength: 1 },
          milestone_key: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
        },
      },
    },
    stories: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "story_key",
          "epic_key",
          "title",
          "description",
          "requirement_ids",
          "ac_ids",
        ],
        properties: {
          story_key: { type: "string", minLength: 1 },
          epic_key: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          requirement_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          ac_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "task_key",
          "story_key",
          "title",
          "description",
          "requirement_ids",
          "ac_ids",
          "allowed_files",
          "depends_on_task_keys",
        ],
        properties: {
          task_key: { type: "string", minLength: 1 },
          story_key: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          requirement_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          ac_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          allowed_files: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          depends_on_task_keys: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
          developer_profile_key: { type: "string", minLength: 1 },
          verification_tier1_command: {
            type: "object",
            additionalProperties: false,
            required: ["command", "args"],
            properties: {
              command: { type: "string", minLength: 1 },
              args: {
                type: "array",
                items: { type: "string" },
              },
              cwd: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
    planning_notes: { type: "string", minLength: 1 },
  },
};

export const STAGE4_CONSISTENCY_CHECK_PROMPT_SPEC: PromptTemplateSpec = {
  promptId: STAGE4_CONSISTENCY_CHECK_PROMPT_ID,
  version: STAGE4_CONSISTENCY_CHECK_PROMPT_VERSION,
  description:
    "Deterministic Stage 4 CrossArtifactConsistencyChecker verification report contract (CHK-01..CHK-05).",
  requiredVariables: [
    "pipeline_session_id",
    "stage1_artifact_id",
    "stage2_artifact_id",
    "stage3_artifact_id",
  ],
  systemTemplate: [
    "Deterministic Stage 4 CrossArtifactConsistencyChecker Contract.",
    "Evaluate CHK-01..CHK-05 across verified Stage 1 items and Stages 1..3 canonical artifacts.",
    "Emit a Stage4ConsistencyReport JSON object matching the registered schema.",
  ].join("\n"),
  userTemplate: [
    "Pipeline Session ID: {{pipeline_session_id}}",
    "Stage 1 Artifact ID: {{stage1_artifact_id}}",
    "Stage 2 Artifact ID: {{stage2_artifact_id}}",
    "Stage 3 Artifact ID: {{stage3_artifact_id}}",
  ].join("\n"),
  outputSchema: STAGE4_CONSISTENCY_CHECK_OUTPUT_SCHEMA,
};

export const STAGE4_CONSISTENCY_CHECK_PROMPT_SHA256 = computePromptSha256(
  STAGE4_CONSISTENCY_CHECK_PROMPT_SPEC
);

export const STAGE7_PLANNING_PROMPT_SPEC: PromptTemplateSpec = {
  promptId: STAGE7_PLANNING_PROMPT_ID,
  version: STAGE7_PLANNING_PROMPT_VERSION,
  description:
    "Stage 7 Development Plan Decomposition into Milestones -> Epics -> Stories -> Stage 8 TaskContracts with 100% Stage 2 req/AC coverage.",
  requiredVariables: [
    "project_id",
    "pipeline_session_id",
    "baseline_id",
    "title",
    "stage2_requirements_json",
    "stage3_architecture_json",
    "protected_paths_json",
    "agent_profiles_json",
  ],
  systemTemplate: [
    "You are the Software Factory v1.5 Stage 7 Delivery Planner.",
    "Decompose the frozen Stage 2 SRS and Stage 3 Architecture into Milestones -> Epics -> User Stories -> executable Stage 8 Task Contracts.",
    "CRITICAL RULES:",
    "1) 100% of Stage 2 req_id and ac_id MUST be covered across both stories and tasks; zero dangling or invented req_id/ac_id.",
    "2) Every task allowed_files MUST be safe relative POSIX globs/paths and MUST NEVER overlap protected_paths or system forbidden paths (.git/**, .factory/**, policy/**, tests/protected/**).",
    "3) Task dependencies (depends_on_task_keys) MUST form a strict acyclic DAG referencing valid task_key values.",
    "4) Optionally bind developer_profile_key to an active DEVELOPER profile from agent_profiles_json.",
    "Respond ONLY with a valid JSON object matching { milestones, epics, stories, tasks, planning_notes }.",
  ].join("\n"),
  userTemplate: [
    "Project ID: {{project_id}}",
    "Pipeline Session ID: {{pipeline_session_id}}",
    "Frozen Baseline ID: {{baseline_id}}",
    "Title: {{title}}",
    "Frozen Stage 2 Requirements:",
    "{{stage2_requirements_json}}",
    "Frozen Stage 3 Architecture:",
    "{{stage3_architecture_json}}",
    "Stage 5 Protected Paths (FORBIDDEN in task allowed_files):",
    "{{protected_paths_json}}",
    "Stage 6 Agent Organization Profiles:",
    "{{agent_profiles_json}}",
  ].join("\n"),
  outputSchema: STAGE7_PLANNING_OUTPUT_SCHEMA,
};

export const DEFAULT_PIPELINE_PROMPT_TEMPLATES: readonly PromptTemplateSpec[] = [
  {
    promptId: STAGE1_DISCOVERY_PROMPT_ID,
    version: STAGE1_DISCOVERY_PROMPT_VERSION,
    description:
      "Stage 1 Idea Discovery Extraction separating explicit Facts from unconfirmed Assumptions & Recommendations (AC-10).",
    requiredVariables: ["project_id", "pipeline_session_id", "title", "raw_idea_text"],
    systemTemplate: [
      "You are the Software Factory v1.5 Stage 1 Product Discovery Analyst.",
      "Classify the user's product idea strictly into:",
      "1) facts: explicit objective requirements or constraints directly stated in raw_idea_text;",
      "2) assumptions: unverified hypotheses requiring user confirmation (must include a clear clarification_question);",
      "3) recommendations: suggested enhancements or technical choices requiring user approval (must include a clear clarification_question).",
      "NEVER promote an assumption into facts.",
      "Respond ONLY with a valid JSON object matching { summary, facts, assumptions, recommendations }.",
    ].join("\n"),
    userTemplate: [
      "Project ID: {{project_id}}",
      "Pipeline Session ID: {{pipeline_session_id}}",
      "Title: {{title}}",
      "Raw Product Idea:",
      "{{raw_idea_text}}",
    ].join("\n"),
    outputSchema: STAGE1_DISCOVERY_OUTPUT_SCHEMA,
  },
  {
    promptId: STAGE2_REQUIREMENTS_PROMPT_ID,
    version: STAGE2_REQUIREMENTS_PROMPT_VERSION,
    description:
      "Stage 2 PRD & SRS Generation bound strictly to AUTO_VERIFIED and CONFIRMED Stage 1 discovery items (AC-10).",
    requiredVariables: [
      "project_id",
      "pipeline_session_id",
      "title",
      "raw_idea_text",
      "confirmed_discovery_items_json",
    ],
    systemTemplate: [
      "You are the Software Factory v1.5 Stage 2 Requirements Engineer.",
      "Generate a rigorous PRD and SRS strictly from the verified Stage 1 discovery items supplied below.",
      "AC-10 RULE: Every requirement MUST cite >= 1 item_id in source_discovery_item_ids from the confirmed_discovery_items_json list.",
      "NEVER reference unconfirmed or rejected assumptions.",
      "Respond ONLY with a valid JSON object matching { prd, srs }.",
    ].join("\n"),
    userTemplate: [
      "Project ID: {{project_id}}",
      "Pipeline Session ID: {{pipeline_session_id}}",
      "Title: {{title}}",
      "Original Idea Context:",
      "{{raw_idea_text}}",
      "Verified Stage 1 Items (AUTO_VERIFIED / CONFIRMED only):",
      "{{confirmed_discovery_items_json}}",
    ].join("\n"),
    outputSchema: STAGE2_REQUIREMENTS_OUTPUT_SCHEMA,
  },
  {
    promptId: STAGE3_ARCHITECTURE_PROMPT_ID,
    version: STAGE3_ARCHITECTURE_PROMPT_VERSION,
    description:
      "Stage 3 Technology & Architecture Design generating Components, ERD, API Spec, Security Controls & ADRs.",
    requiredVariables: ["project_id", "pipeline_session_id", "title", "stage2_prd_srs_json"],
    systemTemplate: [
      "You are the Software Factory v1.5 Stage 3 Principal Architect.",
      "Produce the 5-part technical specification: architecture, database_erd, api_spec, security_design, adrs.",
      "Every req_id from the Stage 2 SRS must be covered by >= 1 component and >= 1 technical design artifact (ERD/API/Security/ADR).",
      "NEVER invent nonexistent req_id references.",
      "Respond ONLY with a valid JSON object matching { architecture, database_erd, api_spec, security_design, adrs }.",
    ].join("\n"),
    userTemplate: [
      "Project ID: {{project_id}}",
      "Pipeline Session ID: {{pipeline_session_id}}",
      "Title: {{title}}",
      "Stage 2 PRD & SRS:",
      "{{stage2_prd_srs_json}}",
    ].join("\n"),
    outputSchema: STAGE3_ARCHITECTURE_OUTPUT_SCHEMA,
  },
  STAGE4_CONSISTENCY_CHECK_PROMPT_SPEC,
  STAGE7_PLANNING_PROMPT_SPEC,
];

export function createDefaultPipelinePromptRegistry(): PromptRegistry {
  const registry = new PromptRegistry();
  registry.registerMany(DEFAULT_PIPELINE_PROMPT_TEMPLATES);
  return registry;
}
