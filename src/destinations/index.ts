import type { DestinationRegistrar } from "../types.ts";
import { cloudflare } from "./cloudflare.ts";

export const destinations: Record<string, DestinationRegistrar> = {
  [cloudflare.id]: cloudflare,
};

export function getDestination(id: string): DestinationRegistrar {
  const dest = destinations[id];
  if (!dest) {
    throw new Error(
      `Unknown destination registrar "${id}". Available: ${Object.keys(destinations).join(", ")}`,
    );
  }
  return dest;
}
