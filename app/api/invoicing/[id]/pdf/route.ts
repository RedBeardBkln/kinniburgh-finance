import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { loadInvoicePdfSource } from "@/lib/invoicing/pdf-build";
import { renderInvoicePdf } from "@/lib/invoicing/pdf/render";
import { isUuid } from "@/lib/invoicing/validate";

// Invoice PDF, generated on demand and streamed. Nothing is stored (the frozen document fields make a reprint identical; the bank
// text, if the document includes it, is read live so a corrected instruction reaches reprints). `auth()` is the first statement and
// returns 401 before anything else is read; a document of any entity other than the allow-listed one is a 404. Never cached.
// pdf-lib needs the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return new NextResponse("Not found", { status: 404 });

  try {
    const source = await loadInvoicePdfSource(id);
    if (source.status === "not_found") return new NextResponse("Not found", { status: 404 });
    if (source.status === "not_migrated") return new NextResponse("Invoicing is not set up yet", { status: 503 });
    const rendered = await renderInvoicePdf(source.input, { logo: source.logo });
    return new NextResponse(Buffer.from(rendered.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${source.filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    console.error("Invoice PDF failed", err instanceof Error ? err.name : "UnknownError");
    return new NextResponse("The PDF could not be generated", { status: 500 });
  }
}
