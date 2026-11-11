import {
  type PromptTemplateSpec,
  type RenderedPrompt,
  canonicalizeJson,
  sha256Hex,
} from "@software-factory/shared-types";

export class PromptVersionConflictError extends Error {
  public readonly code = "ERR_PROMPT_VERSION_CONFLICT" as const;
  public readonly httpStatus = 409 as const;
  public readonly promptId: string;
  public readonly version: string;

  constructor(promptId: string, version: string, message: string) {
    super(message);
    this.name = "PromptVersionConflictError";
    this.promptId = promptId;
    this.version = version;
  }
}

export class PromptNotFoundError extends Error {
  public readonly code = "ERR_PROMPT_NOT_FOUND" as const;
  public readonly httpStatus = 404 as const;
  public readonly promptId: string;
  public readonly version?: string;

  constructor(promptId: string, version?: string) {
    super(
      version
        ? `Prompt template '${promptId}@${version}' is not registered`
        : `Prompt template '${promptId}' has no registered versions`
    );
    this.name = "PromptNotFoundError";
    this.promptId = promptId;
    this.version = version;
  }
}

export class PromptRenderError extends Error {
  public readonly code = "ERR_PROMPT_RENDER_INVALID" as const;
  public readonly httpStatus = 400 as const;

  constructor(message: string) {
    super(message);
    this.name = "PromptRenderError";
  }
}

export interface RegisteredPromptTemplate {
  readonly spec: PromptTemplateSpec;
  readonly promptSha256: string;
}

export function computePromptSha256(spec: PromptTemplateSpec): string {
  return sha256Hex(
    canonicalizeJson({
      promptId: spec.promptId,
      version: spec.version,
      systemTemplate: spec.systemTemplate,
      userTemplate: spec.userTemplate,
      outputSchema: spec.outputSchema,
    })
  );
}

const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Deterministic Immutable Prompt Version Registry (`M6A`).
 * Guarantees `(promptId, version)` cannot be silently mutated and tags every call
 * with `promptSha256` for full audit reproducibility.
 */
export class PromptRegistry {
  private readonly versionsByPromptId = new Map<string, Map<string, RegisteredPromptTemplate>>();

  public register(spec: PromptTemplateSpec): RegisteredPromptTemplate {
    const promptId = spec.promptId.trim();
    const version = spec.version.trim();
    if (!promptId || !version) {
      throw new PromptRenderError("Prompt promptId and version must be non-empty strings");
    }
    if (!spec.systemTemplate.trim() || !spec.userTemplate.trim()) {
      throw new PromptRenderError(
        `Prompt '${promptId}@${version}' must have non-empty systemTemplate and userTemplate`
      );
    }

    const normalizedSpec: PromptTemplateSpec = {
      ...spec,
      promptId,
      version,
    };
    const promptSha256 = computePromptSha256(normalizedSpec);

    let versionMap = this.versionsByPromptId.get(promptId);
    if (!versionMap) {
      versionMap = new Map<string, RegisteredPromptTemplate>();
      this.versionsByPromptId.set(promptId, versionMap);
    }

    const existing = versionMap.get(version);
    if (existing) {
      if (existing.promptSha256 !== promptSha256) {
        throw new PromptVersionConflictError(
          promptId,
          version,
          `Prompt version '${promptId}@${version}' is immutable (existing sha256=${existing.promptSha256}, new sha256=${promptSha256})`
        );
      }
      return existing;
    }

    const registered: RegisteredPromptTemplate = {
      spec: normalizedSpec,
      promptSha256,
    };
    versionMap.set(version, registered);
    return registered;
  }

  public registerMany(specs: readonly PromptTemplateSpec[]): RegisteredPromptTemplate[] {
    return specs.map((spec) => this.register(spec));
  }

  public get(promptId: string, version?: string): RegisteredPromptTemplate {
    const versionMap = this.versionsByPromptId.get(promptId);
    if (!versionMap || versionMap.size === 0) {
      throw new PromptNotFoundError(promptId, version);
    }
    if (version !== undefined) {
      const found = versionMap.get(version);
      if (!found) {
        throw new PromptNotFoundError(promptId, version);
      }
      return found;
    }
    const entries = [...versionMap.values()];
    return entries[entries.length - 1]!;
  }

  public listVersions(promptId: string): RegisteredPromptTemplate[] {
    const versionMap = this.versionsByPromptId.get(promptId);
    if (!versionMap) {
      return [];
    }
    return [...versionMap.values()];
  }

  public listAll(): RegisteredPromptTemplate[] {
    const all: RegisteredPromptTemplate[] = [];
    for (const versionMap of this.versionsByPromptId.values()) {
      for (const entry of versionMap.values()) {
        all.push(entry);
      }
    }
    return all;
  }

  public render(
    promptId: string,
    version: string | undefined,
    variables: Readonly<Record<string, string | number | boolean | null | undefined>> = {}
  ): RenderedPrompt {
    const entry = this.get(promptId, version);
    const { spec, promptSha256 } = entry;

    if (spec.requiredVariables) {
      for (const reqVar of spec.requiredVariables) {
        const val = variables[reqVar];
        if (val === undefined || val === null) {
          throw new PromptRenderError(
            `Missing required variable '${reqVar}' for prompt '${spec.promptId}@${spec.version}'`
          );
        }
      }
    }

    const substitute = (template: string, partName: "systemTemplate" | "userTemplate"): string =>
      template.replace(PLACEHOLDER_REGEX, (_match, varName: string) => {
        const val = variables[varName];
        if (val === undefined || val === null) {
          throw new PromptRenderError(
            `Unresolved placeholder '{{${varName}}}' in ${partName} of '${spec.promptId}@${spec.version}'`
          );
        }
        return String(val);
      });

    return {
      promptId: spec.promptId,
      version: spec.version,
      promptSha256,
      systemPrompt: substitute(spec.systemTemplate, "systemTemplate"),
      userPrompt: substitute(spec.userTemplate, "userTemplate"),
      outputSchema: spec.outputSchema,
    };
  }
}
