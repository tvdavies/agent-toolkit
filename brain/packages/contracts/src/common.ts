import { z } from "zod";

export const SourceRef = z.object({
  kind: z.enum(["slack", "linear", "github", "gmail", "drive", "mock", "user", "memory"]),
  /**
   * For external sources: the system-specific id (e.g. Slack message ts,
   * GitHub PR number). For `kind: "memory"`: the absolute file path of
   * the markdown source file on disk.
   */
  id: z.string(),
  url: z.url().optional(),
  title: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const EntityRef = z.object({
  canonical: z.string(),
  aliases: z.array(z.string()).default([]),
  type: z.string().optional(),
});
export type EntityRef = z.infer<typeof EntityRef>;

export const Message = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
});
export type Message = z.infer<typeof Message>;
