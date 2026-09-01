/**
 * Extracts a JSON object payload from a raw model response. Handles markdown
 * code fences (json or bare, anywhere in the response) and surrounding
 * preamble/postamble text around the outermost object.
 */
export function extractJsonPayload(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in response: ${text.slice(0, 200)}`);
  }
  return candidate.slice(start, end + 1);
}

export function parseModelJson<T>(text: string): T {
  return JSON.parse(extractJsonPayload(text)) as T;
}