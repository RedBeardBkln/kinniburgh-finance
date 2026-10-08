"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { MessageCircle } from "lucide-react";

// The "Ask the assistant" button that opens the slide-over on any signed-in page. AppShell mounts it once (only with a session, so the public
// /queue page never shows it). It renders nothing on the Advisor page itself and in print. The panel is loaded only after the first open, so the
// chat code costs nothing on pages where it is never used.
const AdvisorSlideover = dynamic(() => import("@/components/advisor/advisor-slideover").then((m) => m.AdvisorSlideover), { ssr: false });

export function AdvisorLauncher() {
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  if (pathname === "/advisor" || pathname.startsWith("/advisor/")) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setEverOpened(true);
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg transition-colors hover:bg-primary/90 print:hidden"
      >
        <MessageCircle className="h-4 w-4" aria-hidden="true" />
        Ask the assistant
      </button>
      {everOpened && <AdvisorSlideover open={open} onClose={() => setOpen(false)} pathname={pathname} />}
    </>
  );
}
