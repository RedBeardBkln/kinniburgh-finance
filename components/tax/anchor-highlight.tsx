"use client";

import { useEffect } from "react";

// Deep links land on an element by its id (the fragment of the URL). The browser scrolls there on a full page load, but Next's client
// navigation and a same-page hash change do not mark the target (the CSS :target rule only follows real fragment navigation), so this
// component finds the element named by the fragment on arrival and on every hash change, scrolls it into view (the .anchor-target class
// in app/globals.css leaves room for the header) and flashes it for about three seconds so the owner sees where the link landed.
// It renders nothing and changes no data.

const FLASH_MS = 3200;

export function AnchorHighlight() {
  useEffect(() => {
    let timer: number | undefined;
    let last: HTMLElement | null = null;
    const apply = (): void => {
      let id = window.location.hash.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        return;
      }
      if (id === "") return;
      const el = document.getElementById(id);
      if (el === null) return;
      el.scrollIntoView({ block: "start" });
      if (last !== null) last.classList.remove("anchor-flash");
      // restart the animation when the same element is the target twice in a row
      el.classList.remove("anchor-flash");
      void el.offsetWidth;
      el.classList.add("anchor-flash");
      last = el;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => el.classList.remove("anchor-flash"), FLASH_MS);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => {
      window.removeEventListener("hashchange", apply);
      window.clearTimeout(timer);
    };
  }, []);
  return null;
}
