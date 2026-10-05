import Anthropic from "@anthropic-ai/sdk";
import { LlmTransportError, type LlmRequest, type LlmResponse, type LlmTransport } from "@/lib/tax-review/llm/client";

// The production transport of the AI Return Reviewer: the repo's existing Anthropic SDK (same package and the same
// ANTHROPIC_API_KEY as document extraction and the advisor chat), called through `messages.stream(...).finalMessage()` so a
// long answer does not hit a non-streaming request limit. Server only.
//
// - No temperature is sent (models after Opus 4.6 reject any value but 1.0).
// - SDK retries are OFF (maxRetries 0): retry policy lives in runStructured so it is tested and visible.
// - Errors are mapped to LlmTransportError(kind, status) and NEVER carry the API's message text (it can quote the request);
//   callers log the error class name only.

export function transientStatus(status: number | undefined): boolean {
  return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
}

/** Maps any SDK / network error to a transport error without keeping its text. */
export function mapAnthropicError(err: unknown): LlmTransportError {
  if (err instanceof LlmTransportError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new LlmTransportError("aborted");
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmTransportError("transient");
  if (err instanceof Anthropic.APIConnectionError) return new LlmTransportError("transient");
  const status = err instanceof Anthropic.APIError && typeof err.status === "number" ? err.status : undefined;
  if (transientStatus(status)) return new LlmTransportError("transient", status ?? null);
  return new LlmTransportError("fatal", status ?? null);
}

export function createAnthropicTransport(apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): LlmTransport {
  if (apiKey === undefined || apiKey === "") throw new LlmTransportError("fatal");
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    async send(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      try {
        const outputConfig =
          request.jsonSchema !== undefined || request.effort !== undefined
            ? {
                output_config: {
                  ...(request.effort !== undefined ? { effort: request.effort } : {}),
                  ...(request.jsonSchema !== undefined ? { format: { type: "json_schema" as const, schema: request.jsonSchema } } : {}),
                },
              }
            : {};
        const stream = client.messages.stream(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: [{ role: "user", content: request.user }],
            ...outputConfig,
          },
          { signal }
        );
        const message = await stream.finalMessage();
        const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        // output_tokens includes the model's reasoning ("thinking") tokens and they count against max_tokens; the API reports their number
        // separately (output_tokens_details.thinking_tokens), which is kept so a cut-off answer can be told apart from a long one
        const thinking = message.usage.output_tokens_details?.thinking_tokens;
        return {
          text,
          stopReason: message.stop_reason ?? null,
          usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, ...(typeof thinking === "number" ? { thinkingTokens: thinking } : {}) },
          model: message.model,
        };
      } catch (err) {
        throw mapAnthropicError(err);
      }
    },
  };
}
