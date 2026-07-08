import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { downloadReceiptFile } from "@/lib/supabase-storage";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ policyId: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { policyId } = await params;
  const body = await req.json() as { question?: string };
  const question = body.question?.trim();
  if (!question) return NextResponse.json({ error: "Question required" }, { status: 400 });

  const policy = await db.insurancePolicy.findUnique({
    where: { id: policyId },
    include: { document: { select: { id: true, fileKey: true, extractionStatus: true } } },
  });
  if (!policy) return NextResponse.json({ error: "Policy not found" }, { status: 404 });
  if (!policy.document)
    return NextResponse.json({ error: "No policy document uploaded yet" }, { status: 400 });

  const buffer = await downloadReceiptFile(policy.document.fileKey);
  const base64 = buffer.toString("base64");
  const isPdf = policy.document.fileKey.endsWith(".pdf");

  const contentBlock = isPdf
    ? {
        type: "document" as const,
        source: { type: "base64" as const, media_type: "application/pdf" as const, data: base64 },
      }
    : {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: policy.document.fileKey.endsWith(".png")
            ? ("image/png" as const)
            : ("image/jpeg" as const),
          data: base64,
        },
      };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system:
      "You are a helpful assistant answering questions about an insurance policy document. " +
      "Answer concisely and accurately based only on what is in the document. " +
      "If the information is not present, say so clearly. Do not speculate.",
    messages: [
      { role: "user", content: [contentBlock, { type: "text", text: question }] },
    ],
  });

  const answer = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  return NextResponse.json({ answer });
}
