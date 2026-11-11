import type { StructuredJsonSchema } from "@software-factory/shared-types";

export class StructuredOutputValidationError extends Error {
  public readonly code = "ERR_STRUCTURED_OUTPUT_INVALID" as const;
  public readonly httpStatus = 422 as const;
  public readonly validationErrors: readonly string[];
  public readonly rawText: string;

  constructor(message: string, validationErrors: readonly string[], rawText: string) {
    super(message);
    this.name = "StructuredOutputValidationError";
    this.validationErrors = validationErrors;
    this.rawText = rawText;
  }
}

/**
 * Extracts strictly bounded JSON from model output text (`Fail-Closed`).
 * Accepts ONLY:
 * 1. Pure valid JSON covering the entire trimmed text, OR
 * 2. A single markdown code fence (` ```json ... ``` `) covering the entire trimmed text.
 * Rejects responses with leading/trailing prose, bare fences, or multiple fenced blocks.
 */
export function extractJsonFromModelText(rawText: string): unknown {
  if (typeof rawText !== "string") {
    throw new StructuredOutputValidationError(
      "Model output must be a string",
      ["Model output is not a string"],
      String(rawText)
    );
  }
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new StructuredOutputValidationError(
      "Model returned empty output instead of JSON",
      ["Empty model output"],
      rawText
    );
  }

  let candidateJson = trimmed;
  if (trimmed.startsWith("```")) {
    const fenceMatch = trimmed.match(/^```json[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?```$/i);
    if (!fenceMatch) {
      throw new StructuredOutputValidationError(
        "Model response contained an unclosed, untagged, or trailing-prose code fence",
        ["Code fence must start with ```json and cleanly span entire output"],
        rawText
      );
    }
    const inner = fenceMatch[1] ?? "";
    if (inner.includes("```")) {
      throw new StructuredOutputValidationError(
        "Model response contained multiple markdown code blocks; ambiguous JSON rejected fail-closed",
        ["Multiple code fences detected"],
        rawText
      );
    }
    candidateJson = inner.trim();
  }

  try {
    return JSON.parse(candidateJson) as unknown;
  } catch (err: unknown) {
    throw new StructuredOutputValidationError(
      `Model output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      [`JSON.parse error: ${err instanceof Error ? err.message : String(err)}`],
      rawText
    );
  }
}

function describeRuntimeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function deepJsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepJsonEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (!Object.hasOwn(objB, key) || !deepJsonEqual(objA[key], objB[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Validates parsed JSON value against a `StructuredJsonSchema`.
 * Returns an array of validation error strings (`[]` if valid).
 */
export function validateAgainstJsonSchema(
  value: unknown,
  schema: StructuredJsonSchema,
  path = "$"
): string[] {
  const errors: string[] = [];

  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${path}: invalid schema definition (expected object)`);
    return errors;
  }

  if (schema.enum !== undefined) {
    const matchesEnum = schema.enum.some((allowed) => deepJsonEqual(allowed, value));
    if (!matchesEnum) {
      errors.push(
        `${path}: expected one of [${schema.enum.map((v) => JSON.stringify(v)).join(", ")}], got ${JSON.stringify(value)}`
      );
      return errors;
    }
  }

  switch (schema.type) {
    case "null": {
      if (value !== null) {
        errors.push(`${path}: expected null, got ${describeRuntimeType(value)}`);
      }
      return errors;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        errors.push(`${path}: expected boolean, got ${describeRuntimeType(value)}`);
      }
      return errors;
    }
    case "string": {
      if (typeof value !== "string") {
        errors.push(`${path}: expected string, got ${describeRuntimeType(value)}`);
        return errors;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${path}: string length ${value.length} < minLength ${schema.minLength}`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${path}: string length ${value.length} > maxLength ${schema.maxLength}`);
      }
      if (schema.pattern !== undefined) {
        try {
          const regex = new RegExp(schema.pattern);
          if (!regex.test(value)) {
            errors.push(`${path}: string does not match pattern /${schema.pattern}/`);
          }
        } catch (err: unknown) {
          errors.push(
            `${path}: invalid schema pattern /${schema.pattern}/: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return errors;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${path}: expected ${schema.type}, got ${describeRuntimeType(value)}`);
        return errors;
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        errors.push(`${path}: expected integer, got non-integer number ${value}`);
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${path}: number ${value} < minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${path}: number ${value} > maximum ${schema.maximum}`);
      }
      return errors;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${describeRuntimeType(value)}`);
        return errors;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${path}: array length ${value.length} < minItems ${schema.minItems}`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${path}: array length ${value.length} > maxItems ${schema.maxItems}`);
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i += 1) {
          errors.push(...validateAgainstJsonSchema(value[i], schema.items, `${path}[${i}]`));
        }
      }
      return errors;
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${describeRuntimeType(value)}`);
        return errors;
      }
      const record = value as Record<string, unknown>;
      if (schema.required) {
        for (const reqKey of schema.required) {
          const propSchema = schema.properties?.[reqKey];
          if (!Object.hasOwn(record, reqKey) || record[reqKey] === undefined) {
            errors.push(`${path}.${reqKey}: missing required property`);
          } else if (record[reqKey] === null && !propSchema) {
            errors.push(`${path}.${reqKey}: required property cannot be null`);
          }
        }
      }
      if (schema.properties) {
        for (const [propKey, propSchema] of Object.entries(schema.properties)) {
          if (Object.hasOwn(record, propKey) && record[propKey] !== undefined) {
            errors.push(
              ...validateAgainstJsonSchema(record[propKey], propSchema, `${path}.${propKey}`)
            );
          }
        }
      }
      if (schema.additionalProperties === false) {
        const allowedKeys = new Set(Object.keys(schema.properties ?? {}));
        for (const key of Object.keys(record)) {
          if (!allowedKeys.has(key)) {
            errors.push(`${path}.${key}: additional property is not allowed`);
          }
        }
      }
      return errors;
    }
    default: {
      errors.push(
        `${path}: unsupported or missing schema type '${String((schema as { type?: unknown }).type)}'`
      );
      return errors;
    }
  }
}

export function parseAndValidateStructuredOutput<T>(
  rawText: string,
  schema: StructuredJsonSchema
): T {
  const parsed = extractJsonFromModelText(rawText);
  const errors = validateAgainstJsonSchema(parsed, schema);
  if (errors.length > 0) {
    throw new StructuredOutputValidationError(
      `Structured model output failed schema validation: ${errors.slice(0, 5).join("; ")}`,
      errors,
      rawText
    );
  }
  return parsed as T;
}
