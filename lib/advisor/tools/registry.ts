// Tool registry helpers (plan section 5.1). PURE.
//
// The tool list is sorted by name ONCE and rendered byte-identically on every request: tools render before the system prompt in the
// cached prefix, so any reordering would bust the prompt cache.

import type { JsonSchemaNode, RegisteredTool } from "@/lib/advisor/tools/types";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: RegisteredTool["inputJsonSchema"];
  strict?: boolean;
}

export function sortTools(tools: readonly RegisteredTool[]): RegisteredTool[] {
  const seen = new Set<string>();
  for (const t of tools) {
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(t.name)) throw new Error(`invalid tool name: ${t.name}`);
    if (seen.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
    seen.add(t.name);
  }
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Request `tools` array: fixed key order, no per-request content. `strict` is added only when asked for. */
export function toolDefinitions(sorted: readonly RegisteredTool[], opts: { strict: boolean }): ToolDefinition[] {
  return sorted.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputJsonSchema,
    ...(opts.strict ? { strict: true } : {}),
  }));
}

const ALLOWED_KEYWORDS = new Set(["type", "description", "properties", "required", "additionalProperties", "items"]);

/**
 * Problems with a tool schema relative to the strict-compatible subset: every object has additionalProperties:false and `required` lists
 * only declared properties, only the keywords above are used (the installed SDK's own strict transform keeps just these natively and moves
 * everything else into the description), and arrays carry `items`. [] = fine.
 */
export function findSchemaProblems(schema: JsonSchemaNode, path = "$"): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYWORDS.has(key)) problems.push(`${path}: keyword "${key}" is not in the strict-compatible subset`);
  }
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) problems.push(`${path}: object without additionalProperties:false`);
    const props = schema.properties ?? {};
    for (const r of schema.required ?? []) {
      if (!(r in props)) problems.push(`${path}: required "${r}" is not a declared property`);
    }
    for (const [k, v] of Object.entries(props)) problems.push(...findSchemaProblems(v, `${path}.${k}`));
  } else if (schema.type === "array") {
    if (schema.items === undefined) problems.push(`${path}: array without items`);
    else problems.push(...findSchemaProblems(schema.items, `${path}[]`));
  }
  if (schema.type !== "object" && (schema.properties !== undefined || schema.required !== undefined)) {
    problems.push(`${path}: properties / required on a non-object`);
  }
  return problems;
}

/** Count of optional (not in `required`) properties in a schema, for the conservative strict-mode complexity budget. */
export function countOptionalProperties(schema: JsonSchemaNode): number {
  if (schema.type === "object") {
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    let n = 0;
    for (const [k, v] of Object.entries(props)) n += (required.has(k) ? 0 : 1) + countOptionalProperties(v);
    return n;
  }
  if (schema.type === "array" && schema.items !== undefined) return countOptionalProperties(schema.items);
  return 0;
}
