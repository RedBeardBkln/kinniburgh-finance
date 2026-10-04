// Registry of every FormMap the packet knows. T1 ships the trial 1040 map; T2a/T2b/T3
// add their maps here (one line each).

import type { FormMap } from "@/lib/tax2025/pdf/types";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { f8959Map } from "@/lib/tax2025/pdf/maps/f8959";
import { f8995Map } from "@/lib/tax2025/pdf/maps/f8995";
import { schBMap } from "@/lib/tax2025/pdf/maps/schB";

export const FORM_MAPS: readonly FormMap[] = [f1040Map, schBMap, f8995Map, f8959Map];
