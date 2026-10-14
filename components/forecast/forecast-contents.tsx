"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { activeTocId, buildTocEntries, sameEntries, TOC_SELECTOR, type TocEntry } from "@/lib/page-contents";

function readEntries(main: Element): TocEntry[] {
  return buildTocEntries(
    Array.from(main.querySelectorAll<HTMLElement>(TOC_SELECTOR)).map((el) => ({
      id: el.id,
      label: el.getAttribute("data-toc-label"),
      level: el.getAttribute("data-toc-level"),
    })),
  );
}

/**
 * "On this page" list shown in the sidebar under the Forecast item. It reads the sections the page marked with
 * `data-toc-label` (so it follows the entity and the sections that have loaded), jumps to one with a smooth scroll
 * inside the page's own scroll area, and highlights the section being read. Renders nothing until the page is mounted.
 */
export function ForecastContents({ onNavigate }: { onNavigate?: () => void }) {
  const [entries, setEntries] = useState<TocEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const entriesRef = useRef<TocEntry[]>([]);

  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    let frame = 0;

    const updateActive = () => {
      const mainTop = main.getBoundingClientRect().top;
      const tops = entriesRef.current.flatMap((e) => {
        const el = document.getElementById(e.id);
        return el ? [{ id: e.id, top: el.getBoundingClientRect().top - mainTop }] : [];
      });
      setActiveId(activeTocId(tops, 96));
    };

    const rescan = () => {
      frame = 0;
      const next = readEntries(main);
      if (!sameEntries(entriesRef.current, next)) {
        entriesRef.current = next;
        setEntries(next);
      }
      updateActive();
    };

    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(rescan);
    };

    rescan();
    // Suspense blocks stream in after the first paint and the entity/horizon links swap sections: rescan on change.
    const observer = new MutationObserver(schedule);
    observer.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ["id", "data-toc-label", "data-toc-level"] });
    main.addEventListener("scroll", schedule, { passive: true });
    return () => {
      observer.disconnect();
      main.removeEventListener("scroll", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  if (entries.length === 0) return null;

  function jump(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    setActiveId(id);
    onNavigate?.();
  }

  return (
    <nav aria-label="On this page" className="mb-1 ml-4 mt-0.5 border-l pl-2" data-testid="forecast-contents">
      <ul className="space-y-0.5">
        {entries.map((e) => (
          <li key={e.id}>
            <a
              href={`#${e.id}`}
              onClick={(ev) => {
                ev.preventDefault();
                jump(e.id);
              }}
              aria-current={e.id === activeId ? "location" : undefined}
              className={cn(
                "block rounded px-2 py-1 text-xs leading-snug transition-colors",
                e.level === 2 && "ml-3",
                e.id === activeId
                  ? "bg-accent/60 font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {e.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
