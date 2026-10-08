import Link from "next/link";
import type { Route } from "next";
import { parseMarkdown, type Block, type Inline } from "@/lib/advisor/markdown";

// Renders an assistant reply from the safe markdown AST (lib/advisor/markdown.ts). No dangerouslySetInnerHTML, no raw HTML, no images; a link
// is only ever one of the app's own pages or an allow-listed irs.gov / ct.gov URL (everything else already arrived as plain text).

function Inlines({ nodes }: { nodes: readonly Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.k) {
          case "text":
            return <span key={i}>{n.v}</span>;
          case "bold":
            return (
              <strong key={i}>
                <Inlines nodes={n.c} />
              </strong>
            );
          case "italic":
            return (
              <em key={i}>
                <Inlines nodes={n.c} />
              </em>
            );
          case "code":
            return (
              <code key={i} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">
                {n.v}
              </code>
            );
          case "link":
            return n.external ? (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
                <Inlines nodes={n.c} />
              </a>
            ) : (
              <Link key={i} href={n.href as Route} className="text-primary underline underline-offset-2">
                <Inlines nodes={n.c} />
              </Link>
            );
        }
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.k) {
    case "p":
      return (
        <p className="leading-relaxed">
          <Inlines nodes={block.c} />
        </p>
      );
    case "h":
      return (
        <p className={block.level <= 2 ? "font-semibold text-base" : "font-semibold"}>
          <Inlines nodes={block.c} />
        </p>
      );
    case "ul":
      return (
        <ul className="list-disc space-y-1 pl-5">
          {block.items.map((it, i) => (
            <li key={i}>
              <Inlines nodes={it} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="list-decimal space-y-1 pl-5">
          {block.items.map((it, i) => (
            <li key={i}>
              <Inlines nodes={it} />
            </li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <blockquote className="border-l-2 pl-3 text-muted-foreground">
          <Inlines nodes={block.c} />
        </blockquote>
      );
    case "code":
      return <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{block.v}</pre>;
    case "hr":
      return <hr className="my-1" />;
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {block.head.map((c, i) => (
                  <th key={i} className="border-b px-2 py-1 text-left font-medium">
                    <Inlines nodes={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i} className="border-b px-2 py-1 align-top">
                      <Inlines nodes={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function MarkdownView({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="space-y-2 text-sm">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}
