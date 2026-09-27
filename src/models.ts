/**
 * Effort levels the analyst can pick, and the model each one runs on. Shared by
 * the UI (labels) and the server (which maps an effort to a model id, so the
 * client can never request an arbitrary model).
 */

export const EFFORTS = {
  low: { label: "Low", modelName: "Haiku 4.5", model: "claude-haiku-4-5" },
  medium: { label: "Medium", modelName: "Sonnet 5", model: "claude-sonnet-5" },
  high: { label: "High", modelName: "Opus 5", model: "claude-opus-5" },
} as const;

export type Effort = keyof typeof EFFORTS;

export const DEFAULT_EFFORT: Effort = "medium";

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && Object.hasOwn(EFFORTS, value);
}
