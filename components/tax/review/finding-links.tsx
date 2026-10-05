"use client";

import Link from "next/link";
import type { Route } from "next";
import { REVIEW_FILTER_EVENT, type FindingLink } from "@/lib/tax-review/links";

// The labelled links of a finding, a register entry, a by-hand item, an information statement or a gate row (lib/tax-review/links.ts decides
// WHERE each goes; this only draws them). Everything stays in the same tab except the PDF, which opens in a new tab so the Final review keeps
// its place. An internal page uses next/link (no prefetch: the review sheet builds the whole return); the PDF and a jump inside this page are
// plain anchors. A "findings" jump also tells the findings table which filter to apply (the table listens for the event). No window.open.

const LINK_CLASS = "inline-flex min-h-[44px] items-center text-primary underline-offset-2 hover:underline sm:min-h-0";

function OneLink({ link }: { link: FindingLink }) {
  if (link.newTab) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
        {link.label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  if (link.kind === "jump") {
    const filter = link.href.startsWith("#findings-");
    return (
      <a href={link.href} className={LINK_CLASS} onClick={filter ? () => window.dispatchEvent(new CustomEvent(REVIEW_FILTER_EVENT, { detail: link.href })) : undefined}>
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href as Route} prefetch={false} className={LINK_CLASS}>
      {link.label}
    </Link>
  );
}

export function LinkList({ links, testId }: { links: readonly FindingLink[]; testId?: string }) {
  if (links.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs" data-testid={testId} data-link-count={links.length}>
      {links.map((l) => (
        <li key={`${l.kind}-${l.href}`} data-link-kind={l.kind}>
          <OneLink link={l} />
        </li>
      ))}
    </ul>
  );
}
