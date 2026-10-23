"use client";

import { useEffect } from "react";
import { markInvoiceViewed } from "@/actions/public-invoice";

// Counts the client's view AFTER the page has mounted in a real browser (a link-preview bot's GET of the HTML does not run this).
// Renders nothing; a failure is silent (the view count is not worth an error on the client's page).
export function ViewTracker({ token }: { token: string }) {
  useEffect(() => {
    markInvoiceViewed(token).catch(() => undefined);
  }, [token]);
  return null;
}
