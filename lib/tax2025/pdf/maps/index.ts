// Registry of every FormMap the packet knows. T1 ships the trial 1040 map; T2a/T2b/T3
// add their maps here (one line each).

import type { FormMap } from "@/lib/tax2025/pdf/types";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";

export const FORM_MAPS: readonly FormMap[] = [f1040Map];
