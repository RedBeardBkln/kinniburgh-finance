import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownView } from "@/components/advisor/markdown-view";
import { MessageBubble } from "@/components/advisor/message-bubble";
import { ToolChips } from "@/components/advisor/tool-chips";
import type { UiMessage } from "@/lib/advisor/chat-state";

// Static renders of the presentational pieces (the repo has no DOM test infra; the interactive workspace is covered by the Tester's manual
// walk-through). These prove the markup is inert for hostile model text and that links are only the allowed ones.
// MessageBubble renders the memory-suggestion chip, which calls a server action; the real action module needs next-auth / next/server, so the render
// tests stub it (they never click).
vi.mock("@/actions/advisor", () => ({ confirmMemorySuggestion: async () => ({ ok: false, error: "stub" }) }));

(globalThis as unknown as { React: typeof React }).React = React;

const render = (md: string) => renderToStaticMarkup(<MarkdownView text={md} />);

describe("MarkdownView markup is inert", () => {
  it("escapes raw HTML and script text", () => {
    const html = render('<script>alert(1)</script> <img src=x onerror=alert(1)> **bold**');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong><span>bold</span></strong>");
  });

  it("renders only allowed links as anchors; dangerous or unknown targets are plain text", () => {
    const html = render(
      [
        "[Tax Forms](/tax/forms/2025)",
        "[IRS](https://www.irs.gov/pub/irs-pdf/p463.pdf)",
        "[bad](javascript:alert(1))",
        "[data](data:text/html;base64,AAAA)",
        "[evil](https://evil.example.com/)",
        "[vault](/vault)",
        "![pic](https://www.irs.gov/a.png)",
      ].join("\n\n"),
    );
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/tax/forms/2025", "https://www.irs.gov/pub/irs-pdf/p463.pdf"]);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/javascript:|data:text/);
    expect(html).toContain("bad");
  });

  it("renders a table, lists and code without raw HTML pass-through", () => {
    const html = render("| A | B |\n| - | - |\n| 1 | 2 |\n\n- one\n- two\n\n`x<y`");
    expect(html).toContain("<table");
    expect(html).toContain("<td");
    expect(html).toContain("<ul");
    expect(html).toContain("<code");
    expect(html).toContain("x&lt;y");
  });
});

describe("MessageBubble", () => {
  const base: UiMessage = { id: "1", role: "assistant", text: "Answer", tools: [], links: [], notices: [], streaming: false, error: null };

  it("shows tool chips, notices and Sources links for known pages only", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          ...base,
          tools: [{ id: "t", name: "search_transactions", text: "Transactions (25 rows)", state: "done" }],
          notices: ["I ran out of time before finishing."],
          links: [
            { label: "Tax Forms", path: "/tax/forms/2025" },
            { label: "Sneaky", path: "/vault" },
          ],
        }}
      />,
    );
    expect(html).toContain("Transactions (25 rows)");
    expect(html).toContain("I ran out of time before finishing.");
    expect(html).toContain("Sources:");
    expect(html).toContain('href="/tax/forms/2025"');
    expect(html).not.toContain("/vault");
    expect(html).not.toContain("Sneaky");
  });

  it("a user message is plain text, never markdown or HTML", () => {
    const html = renderToStaticMarkup(<MessageBubble message={{ ...base, role: "user", text: "<b>hi</b> **x**" }} />);
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt; **x**");
  });

  it("an empty streaming bubble says it is working; an error is shown neutrally", () => {
    expect(renderToStaticMarkup(<MessageBubble message={{ ...base, text: "", streaming: true }} />)).toContain("Working on it...");
    expect(renderToStaticMarkup(<MessageBubble message={{ ...base, text: "", error: "The assistant is busy right now." }} />)).toContain("The assistant is busy right now.");
  });
});

describe("ToolChips", () => {
  it("renders nothing without chips, and running chips end with an ellipsis", () => {
    expect(renderToStaticMarkup(<ToolChips chips={[]} />)).toBe("");
    const html = renderToStaticMarkup(<ToolChips chips={[{ id: "a", name: "list_goals", text: "Looking up goals", state: "running" }]} />);
    expect(html).toContain("Looking up goals...");
  });
});
