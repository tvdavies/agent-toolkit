import type { Connector, IngestedItem, Tool } from "@ai-assistant/contracts";
import { z } from "zod";

const MOCK_MESSAGES: readonly {
  id: string;
  channel: string;
  user: string;
  ts: string;
  text: string;
}[] = [
  {
    id: "1",
    channel: "devs",
    user: "alex",
    ts: "2026-04-22T10:00:00Z",
    text: "Jeff's brain just hit 93.4% on LongMemEval oracle with gpt-4o actor and judge.",
  },
  {
    id: "2",
    channel: "devs",
    user: "badr",
    ts: "2026-04-22T10:05:00Z",
    text: "Two-layer memory model decided: episodic transient + semantic persistent.",
  },
  {
    id: "3",
    channel: "devs",
    user: "tom",
    ts: "2026-04-23T14:00:00Z",
    text: "Mobile-first personal assistant using on-device model for small inference.",
  },
];

const searchArgs = z.object({ query: z.string() });
const searchResult = z.array(
  z.object({
    id: z.string(),
    channel: z.string(),
    user: z.string(),
    ts: z.string(),
    text: z.string(),
  }),
);
type SearchArgs = z.infer<typeof searchArgs>;
type SearchResult = z.infer<typeof searchResult>;

/**
 * M0 canned-messages connector. Stands in for Slack until the real
 * connector lands at M2.
 */
export class MockConnector implements Connector {
  readonly id = "mock";
  readonly scopes = [] as const;

  tools(): Tool[] {
    const tool: Tool<SearchArgs, SearchResult> = {
      name: "mock.search",
      description: "Search canned mock messages by substring.",
      argsSchema: searchArgs,
      resultSchema: searchResult,
      tags: ["read"],
      async call(args) {
        const q = args.query.toLowerCase();
        return MOCK_MESSAGES.filter((m) => m.text.toLowerCase().includes(q));
      },
    };
    return [tool as Tool];
  }

  async *backfill(): AsyncIterable<IngestedItem> {
    for (const m of MOCK_MESSAGES) {
      yield {
        source: { kind: "mock", id: m.id },
        content: `[#${m.channel}] ${m.user}: ${m.text}`,
        metadata: { channel: m.channel, user: m.user },
        ingestedAt: new Date(m.ts),
        entities: [],
      };
    }
  }
}
