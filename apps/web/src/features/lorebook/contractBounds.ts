import type { ZodIssue, ZodTypeAny } from "zod";

// Editors mirror the bounds the shared contracts enforce instead of restating
// them: the Sticky/Cooldown/Delay dials had no
// `max` while the contract caps them at 1000, the bulk sticky input said 1000
// on its own, drive rows could be saved blank against `min(1)`, and a date
// override could exceed the contract's 120 characters — each ending in the
// server's generic "invalid …" 400 with no field named. The helpers below read
// a bound off a Zod schema (through default/optional/nullable/effects
// wrappers) and turn a failed client-side parse into a message that names the
// field, so the editors stay in step with `@tracyhill-rp/contracts` by
// construction. Feature-neutral; lives here because this folder was its first
// consumer (drives and world import it too).

type WrapperDef = { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny };
type ArrayDef = { maxLength?: { value: number } | null };

/** The schema under default/optional/nullable/effects wrappers. */
export function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  for (;;) {
    const def = current._def as WrapperDef;
    if ((def.typeName === "ZodDefault" || def.typeName === "ZodOptional" || def.typeName === "ZodNullable") && def.innerType) current = def.innerType;
    else if (def.typeName === "ZodEffects" && def.schema) current = def.schema;
    else return current;
  }
}

/** `min`/`max` of a numeric field — undefined when the schema sets none. */
export function numberBounds(schema: ZodTypeAny): { min?: number; max?: number } {
  const inner = unwrapSchema(schema) as unknown as { minValue?: number | null; maxValue?: number | null };
  return {
    ...(inner.minValue != null ? { min: inner.minValue } : {}),
    ...(inner.maxValue != null ? { max: inner.maxValue } : {}),
  };
}

/** `.max(n)` of a string field, for an input's `maxLength`. */
export function stringMaxLength(schema: ZodTypeAny): number | undefined {
  const inner = unwrapSchema(schema) as unknown as { maxLength?: number | null };
  return inner.maxLength ?? undefined;
}

/** `.max(n)` of an array field — the row cap of a list editor. */
export function arrayMaxLength(schema: ZodTypeAny): number | undefined {
  return (unwrapSchema(schema)._def as ArrayDef).maxLength?.value;
}

/** The element schema of an array field. */
export function arrayElement(schema: ZodTypeAny): ZodTypeAny {
  return (unwrapSchema(schema) as unknown as { element: ZodTypeAny }).element;
}

/** The value schema of a record field. */
export function recordValue(schema: ZodTypeAny): ZodTypeAny {
  return (unwrapSchema(schema) as unknown as { valueSchema: ZodTypeAny }).valueSchema;
}

export type FieldLabeler = (path: ReadonlyArray<string | number>) => string;

function unitOf(type: string): string {
  return type === "string" ? " characters" : type === "array" ? " items" : "";
}

/** One line naming the offending field(s) of a failed parse, first `limit` issues. */
export function describeContractIssues(issues: ReadonlyArray<ZodIssue>, labelFor: FieldLabeler, limit = 3): string {
  const lines = issues.slice(0, limit).map((issue) => {
    const label = labelFor(issue.path);
    switch (issue.code) {
      case "too_big":
        return `${label} must be at most ${issue.maximum}${unitOf(issue.type)}`;
      case "too_small":
        return issue.type === "string" && Number(issue.minimum) <= 1
          ? `${label} must not be blank`
          : `${label} must be at least ${issue.minimum}${unitOf(issue.type)}`;
      default:
        return `${label}: ${issue.message}`;
    }
  });
  const more = issues.length - lines.length;
  return lines.join("; ") + (more > 0 ? ` (+${more} more)` : "");
}
