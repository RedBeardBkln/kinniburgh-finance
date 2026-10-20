import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";
import { MODAL_OVERLAY, modalPanelClass, type ModalSize } from "@/components/ui/modal-frame";

const SIZES: ModalSize[] = ["sm", "md", "lg", "xl", "2xl", "5xl"];

describe("modal frame (mobile-layout-cleanup)", () => {
  it("panel classes fit a phone and keep the sm+ card look", () => {
    for (const s of SIZES) {
      const panel = modalPanelClass(s).split(" ");
      expect(panel, s).toContain(`max-w-${s}`);
      expect(panel).toContain("w-full");
      expect(panel).toContain("max-h-[92dvh]");
      expect(panel).toContain("sm:max-h-[90vh]");
      expect(panel).toContain("rounded-t-xl");
      expect(panel).toContain("sm:rounded-lg");
      expect(panel).toContain("overflow-y-auto");
      const inner = modalPanelClass(s, "inner").split(" ");
      expect(inner).toContain("flex");
      expect(inner).toContain("flex-col");
      expect(inner).toContain("overflow-hidden");
      expect(inner).not.toContain("overflow-y-auto");
    }
  });

  it("the overlay is a bottom sheet on phones and centred from sm up", () => {
    const o = MODAL_OVERLAY.split(" ");
    for (const c of ["fixed", "inset-0", "z-50", "flex", "items-end", "justify-center", "sm:items-center", "sm:p-4"]) expect(o).toContain(c);
    expect(o).not.toContain("p-4"); // no padding on phones: the sheet spans the screen
  });

  it("caller classes merge without losing the responsive frame", () => {
    const merged = cn(modalPanelClass("md"), "space-y-4 bg-background p-6 shadow-xl").split(" ");
    expect(merged).toContain("sm:rounded-lg");
    expect(merged).toContain("rounded-t-xl");
    expect(merged).toContain("p-6");
    expect(merged).toContain("max-h-[92dvh]");
    const overlay = cn(MODAL_OVERLAY, "bg-black/40").split(" ");
    expect(overlay).toContain("bg-black/40");
    expect(overlay).not.toContain("bg-black/50");
    expect(cn(MODAL_OVERLAY, "z-[60]").split(" ")).not.toContain("z-50");
  });
});
