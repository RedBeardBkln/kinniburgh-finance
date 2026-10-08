// Tester probes: the REAL MarkdownView / MessageBubble rendered to static HTML with hostile model output (no DOM infrastructure exists in
// this repo, so interactive behaviour is NOT covered here; see 03-test-report.md "Not tested").
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownView } from "@/components/advisor/markdown-view";
import { MessageBubble } from "@/components/advisor/message-bubble";
import { applyEvent, emptyTurn, liveMessage } from "@/lib/advisor/chat-state";

// MessageBubble renders the memory-suggestion chip, which calls a server action; the real action module needs next-auth / next/server, so the render
// tests stub it (they never click).
vi.mock("@/actions/advisor", () => ({ confirmMemorySuggestion: async () => ({ ok: false, error: "stub" }) }));

(globalThis as unknown as { React: typeof React }).React = React;

const HOSTILE = [
  "[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](data:text/html;base64,AAAA) [c2](vbscript:x)",
  "![img](https://evil.example/x.png) ![img2](/tax/forms/2025)",
  "<script>alert(1)</script> <img src=x onerror=alert(1)> <a href=\"https://evil.example\">raw</a> <iframe src=//evil></iframe>",
  "[d](//evil.example) [e](https://irs.gov.evil.example/x) [f](https://www.irs.gov@evil.example/) [g](/vault) [h](/tax/forms/2025/../../vault)",
  "[i](/\\evil.example) [j](http://www.irs.gov/pub) [k](https://www.irs.gov:8443/x) [l](/api/advisor/chat) [m](/tax/forms/2025?next=//evil.example)",
  "[ok1](/tax/forms/2025) [ok2](https://www.irs.gov/pub/irs-pdf/f1040.pdf) [ok3](/transactions?q=coffee)",
  "[n](<javascript:alert(1)>) [o](https://irs.gov/a%0d%0aSet-Cookie:x) [p](  javascript:alert(1)) [q](&#106;avascript:alert(1))",
  "| a | b |\n|---|---|\n| [x](javascript:alert(1)) | <b>bold</b> |",
  "```\n<script>alert(2)</script>\n```",
].join("\n\n");

describe("hostile model output rendered through the real components", () => {
  const html = renderToStaticMarkup(<MarkdownView text={HOSTILE} />);
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

  it("contains no script, iframe, image, event handler or javascript/data/vbscript URL", () => {
    expect(html).not.toMatch(/<script|<iframe|<img|<object|<embed|<svg/i);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/(?:href|src)="(?:javascript|data|vbscript):/i);
  });

  it("only the allow-listed links are anchors", () => {
    expect(hrefs.sort()).toEqual(["/tax/forms/2025", "/transactions?q=coffee", "https://www.irs.gov/pub/irs-pdf/f1040.pdf"].sort());
  });

  it("external anchors are noopener noreferrer in a new tab", () => {
    expect(html).toMatch(/<a href="https:\/\/www\.irs\.gov\/pub\/irs-pdf\/f1040\.pdf" target="_blank" rel="noopener noreferrer"/);
  });

  it("raw HTML is shown as escaped text, not interpreted", () => {
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("message bubble", () => {
  it("source links from a stored/streamed 'done' are re-filtered through isKnownAppPath", () => {
    const view = applyEvent(emptyTurn(), {
      t: "done",
      messageId: "m",
      text: "ok",
      stop: "end_turn",
      usage: { in: 0, out: 0, cacheRead: 0 },
      links: [
        { label: "Tax Forms", path: "/tax/forms/2025" },
        { label: "Evil", path: "https://evil.example" },
        { label: "Vault", path: "/vault" },
      ],
    });
    const html = renderToStaticMarkup(<MessageBubble message={liveMessage("x", view, false)} />);
    expect(html).toContain('href="/tax/forms/2025"');
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("/vault");
  });

  it("a user message is rendered as text (no markdown, no HTML)", () => {
    const html = renderToStaticMarkup(<MessageBubble message={{ id: "u", role: "user", text: "<img src=x onerror=alert(1)> **b**", tools: [], links: [], notices: [], streaming: false, error: null }} />);
    expect(html).not.toMatch(/<img/);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<strong>");
  });

  // CONFIRMED (low) robustness gap, see 03-test-report.md D4: the client reducer has no end-of-stream rule. If the byte stream ends cleanly
  // WITHOUT a `done` event (for example the function is cut off at maxDuration), nothing marks the turn finished, so the bubble keeps its
  // "Working on it..." spinner (when no text arrived yet) and shows no error. Pinned with it.fails; flip when the workspace handles EOF.
  it.fails("D4: a stream that ends without 'done' leaves the bubble finished with a message, not spinning forever", () => {
    let view = emptyTurn();
    view = applyEvent(view, { t: "meta", conversationId: "c", userMessageId: "u", title: "t", remaining: { turns: 3 } });
    view = applyEvent(view, { t: "tool", id: "t1", name: "list_goals", label: "Looking up goals", state: "start" });
    // ...connection closed here: the workspace calls paint() with !view.finished and then only setStreaming(false)
    const html = renderToStaticMarkup(<MessageBubble message={liveMessage("x", view, !view.finished)} />);
    expect(html).not.toContain("Working on it");
  });
});
