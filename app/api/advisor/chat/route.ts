import { auth } from "@/lib/auth";
import { buildAdvisorContext } from "@/lib/advisor-context";
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { messages } = (await req.json()) as {
    messages: { role: "user" | "assistant"; content: string }[];
  };

  if (!messages || messages.length === 0) {
    return new Response("messages required", { status: 400 });
  }

  const financialContext = await buildAdvisorContext();

  const systemPrompt = `You are a personal financial advisor for a family called the Kinniburgh household. You have been given full access to their financial data below. Your role is to:

1. Analyze their financial situation objectively and thoroughly
2. Provide strategic guidance aligned with their stated goals
3. Highlight risks, opportunities, and areas needing attention
4. Give specific, actionable recommendations with concrete next steps
5. Be honest about trade-offs and uncertainties

IMPORTANT DISCLAIMERS (state these when giving specific investment or legal advice):
- All recommendations require independent research and validation before acting
- You are not a licensed financial planner, tax advisor, or attorney
- Past performance does not guarantee future results
- This is educational guidance, not professional advice

Keep responses focused and practical. When the user asks follow-up questions, use the full financial context below to give precise, data-grounded answers.

---

${financialContext}`;

  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const stream = await client.messages.create({
          model: "claude-opus-4-8",
          max_tokens: 2048,
          stream: true,
          system: systemPrompt,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });

        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(readable, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
