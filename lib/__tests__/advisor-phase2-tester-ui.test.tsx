// Tester probe: static renders (no DOM infra in this repo) of the Phase 2 UI pieces, and source review of the sessionStorage / print / hook rules.
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const path = vi.hoisted(() => ({ current: "/forecast" as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => path.current }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/actions/advisor", () => ({ confirmMemorySuggestion: async () => ({ ok: true }), getMyConversation: async () => null }));
vi.mock("@/actions/advisor-usage", () => ({ getMyAdvisorUsage: async () => ({ turnsLeft: 3, tokens24h: 1200 }) }));
(globalThis as unknown as { React: typeof React }).React = React;

import { AdvisorLauncher } from "@/components/advisor/advisor-launcher";
import { AdvisorSlideover } from "@/components/advisor/advisor-slideover";
import { MemoryProposalChip } from "@/components/advisor/memory-proposal-chip";
import { MessageBubble } from "@/components/advisor/message-bubble";
import { Composer } from "@/components/advisor/composer";
import type { UiMessage } from "@/lib/advisor/chat-state";

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");

describe("launcher", () => {
  it("renders the button on an ordinary page, print-hidden, and nothing on /advisor or a nested /advisor path", () => {
    path.current = "/forecast";
    const html = renderToStaticMarkup(<AdvisorLauncher />);
    expect(html).toContain("Ask the assistant");
    expect(html).toContain("print:hidden");
    expect(html).toContain('aria-expanded="false"');
    for (const p of ["/advisor", "/advisor/", "/advisor/anything"]) {
      path.current = p;
      expect(renderToStaticMarkup(<AdvisorLauncher />), p).toBe("");
    }
    path.current = null; // usePathname can be null
    expect(renderToStaticMarkup(<AdvisorLauncher />)).toContain("Ask the assistant");
  });
});

describe("slide-over", () => {
  it("closed: inert + aria-hidden + translated off screen + print:hidden; open: not inert, labelled, non-modal", () => {
    const closed = renderToStaticMarkup(<AdvisorSlideover open={false} onClose={() => undefined} pathname="/tax/forms/2025" />);
    expect(closed).toContain('role="dialog"');
    expect(closed).toContain('aria-modal="false"');
    expect(closed).toContain('aria-label="Assistant"');
    expect(closed).toMatch(/\binert(=""| )/);
    expect(closed).toContain('aria-hidden="true"');
    expect(closed).toContain("print:hidden");
    expect(closed).toContain("translate-x-full");
    const open = renderToStaticMarkup(<AdvisorSlideover open onClose={() => undefined} pathname="/tax/forms/2025" />);
    expect(open).not.toMatch(/\binert(=""| )/);
    expect(open).toContain('aria-hidden="false"');
    expect(open).toContain("Looking at: Tax Forms, tax year 2025");
    expect(open).toContain("Close the assistant");
    expect(open).toContain("New chat");
    expect(open).not.toContain("Open in Advisor"); // no conversation yet
  });
  it("the context chip is the closed-set label only: no slug / id / query appears", () => {
    const html = renderToStaticMarkup(<AdvisorSlideover open onClose={() => undefined} pathname="/business/sudden-valley-property-management/pl" />);
    expect(html).toContain("Looking at: Business profit and loss");
    expect(html).not.toContain("sudden-valley");
    const none = renderToStaticMarkup(<AdvisorSlideover open onClose={() => undefined} pathname="/login?x=1" />);
    expect(none).not.toContain("Looking at");
  });
  it("source: every sessionStorage access is inside try/catch, the key is UUID-validated, window use is inside effects/handlers only", () => {
    const src = read("components/advisor/advisor-slideover.tsx");
    const accesses = [...src.matchAll(/sessionStorage\./g)].length;
    expect(accesses).toBeGreaterThanOrEqual(3);
    // every sessionStorage line lies between a `try {` and its `catch`
    const fns = src.split(/\nfunction /).slice(1).filter((s) => /sessionStorage\./.test(s));
    expect(fns.length).toBe(2);
    for (const fn of fns) expect(fn.split("\n}\n")[0]).toMatch(/try \{[\s\S]*sessionStorage\.[\s\S]*\} catch/);
    // and nothing outside those two helpers touches it
    expect(src.replace(/\nfunction (read|write)StoredId[\s\S]*?\n\}\n/g, "\n")).not.toMatch(/sessionStorage\./);
    expect(src).toMatch(/UUID\.test\(v\)/);
    // no top-level window access (would break SSR of the dynamic import? it is ssr:false but keep it safe)
    expect(src.replace(/function (read|write)StoredId[\s\S]*?\n\}\n/g, "")).not.toMatch(/^const .*window\./m);
  });
});

describe("memory chip", () => {
  it("shows the exact text, the click-to-save wording, Save and Dismiss; hostile HTML in the note is escaped", () => {
    const html = renderToStaticMarkup(<MemoryProposalChip text={"Prefers <b>short</b> answers"} category="preference" />);
    expect(html).toContain("Suggested by the assistant. Saved only if you click Save.");
    expect(html).toContain("Save");
    expect(html).toContain("Dismiss");
    expect(html).toContain("&lt;b&gt;short&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("Saved to the household");
  });
  it("an unknown category still renders (as Note) and the bubble shows one chip per proposal", () => {
    const msg: UiMessage = { id: "m", role: "assistant", text: "ok", tools: [], links: [], notices: [], streaming: false, error: null, proposals: [{ id: "a", text: "One", category: "weird" }, { id: "b", text: "Two", category: "household" }] };
    const html = renderToStaticMarkup(<MessageBubble message={msg} />);
    expect((html.match(/Suggested memory note/g) ?? []).length).toBe(2);
    expect(html).toContain("Note");
  });
});

describe("composer usage line", () => {
  const base = { value: "", onChange: () => undefined, onSend: () => undefined, onStop: () => undefined, streaming: false, maxChars: 4000 };
  it("never shows a dollar sign or cost wording; 0 left shows 0", () => {
    const a = renderToStaticMarkup(<Composer {...base} turnsLeft={12} tokens24h={48_000} />);
    expect(a).toContain("12 questions left today.");
    expect(a).toContain("About 48k tokens used in the last 24 hours.");
    expect(a).not.toMatch(/\$|cost|price|dollar/i);
    const z = renderToStaticMarkup(<Composer {...base} turnsLeft={0} tokens24h={1_500_000} />);
    expect(z).toContain("0 questions left today.");
    expect(z).toContain("1.5M");
  });
});

describe("hook extraction: /advisor behaviour preserved (static review of the move)", () => {
  const hook = read("components/advisor/use-advisor-chat.ts");
  const ws = read("components/advisor/advisor-workspace.tsx");
  it("the hook keeps every error / stop behaviour of the old inline send()", () => {
    expect(hook).toContain('"Your session expired. Sign in again."');
    expect(hook).toContain("if (res.status === 429) setTurnsLeft(0);");
    expect(hook).toContain('notices: [...view.notices, "Stopped."]');
    expect(hook).toContain("abortRef.current?.abort()");
    expect(hook).toContain("setStreaming(false)");
  });
  it("the workspace no longer owns fetch / abort; it delegates and still wires onMeta -> url + conversation list", () => {
    expect(ws).not.toContain("fetch(");
    expect(ws).not.toContain("AbortController");
    expect(ws).toContain("chat.send()");
    expect(ws).toContain("setUrl(conversationId)");
    expect(ws).toContain("onStop={chat.stop}");
  });
  it("the page context sent from /advisor itself is the pathname only", () => {
    expect(hook).toMatch(/JSON\.stringify\(\{ conversationId: activeId, message, \.\.\.\(pageContext !== undefined \? \{ pageContext \} : \{\}\) \}\)/);
    expect(ws).toContain("getPageContext: () => ({ path: window.location.pathname })");
  });
});
