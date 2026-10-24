import type { TSchema } from "typebox";

/**
 * Pi accepts plain JSON Schema for tool parameters: its validator coerces and
 * checks schemas that carry no TypeBox kind. The shared definitions in
 * `src/core/tools.ts` are plain JSON Schema, so they only need the type.
 */
export function piParameters(schema: object): TSchema {
  return structuredClone(schema) as TSchema;
}
