import type { SourceRegistrar } from "../types.ts";
import { godaddy } from "./godaddy.ts";
import { squarespace } from "./squarespace.ts";

export const sources: Record<string, SourceRegistrar> = {
  [godaddy.id]: godaddy,
  [squarespace.id]: squarespace,
};

export function getSource(id: string): SourceRegistrar {
  const src = sources[id];
  if (!src) {
    throw new Error(
      `Unknown source registrar "${id}". Available: ${Object.keys(sources).join(", ")}`,
    );
  }
  return src;
}
