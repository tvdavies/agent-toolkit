/**
 * `brain cycle` — run the dream-cycle daemon.
 *
 * Modes:
 *   brain cycle                       # one-shot, all phases
 *   brain cycle --phase=link-fix      # one phase
 *   brain cycle --async               # enqueue for daemon, return immediately
 *   brain cycle --watch               # long-running, sleeps between cycles
 *   brain cycle --watch --interval=1h # custom interval
 *   brain cycle --dry-run             # preview, no writes
 *   brain cycle --force               # ignore phase cooldowns
 *   brain cycle --json                # CycleReport JSON
 */

import { clearLine, cursorTo } from "node:readline";
import {
  type CycleProgressEvent,
  type CycleReport,
  createDedupPhase,
  createMemorySynthesizePhase,
  createPatternsPhase,
  createReflectPhase,
  createStalePhase,
  linkFixPhase,
  type Phase,
  runCycle,
} from "@ai-assistant/memory";
import { buildMemorySynthesizeGenerator } from "../daemon/memory-synthesize-generator.js";
import { buildPatternsGenerator } from "../daemon/patterns-generator.js";
import { loadRecentReflections } from "../daemon/reflection-loader.js";
import {
  buildSynthesizeGenerator,
  loadRecentEpisodicAsTranscripts,
} from "../daemon/synthesize-generator.js";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag } from "../shared/args.js";
import {
  authDir,
  buildBrainChatModel,
  openBrain,
  resolveBrainHome,
  resolveBrainPath,
  resolveScope,
} from "../shared/brain.js";
import { enqueueCycleRequest } from "../shared/cycle-queue.js";
import {
  listRecentSourceDocumentRecords,
  renderRecordForMemory,
  sourceEnvelopeForRecord,
} from "../shared/sources.js";

const PHASE_NAMES = ["link-fix", "reflect", "synthesize", "dedup", "stale", "patterns"] as const;
type PhaseName = (typeof PHASE_NAMES)[number];

export async function runCycleCmd(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const dryRun = bool(args, "dry-run");
  const json = bool(args, "json");
  const watch = bool(args, "watch");
  const async = bool(args, "async");
  const force = bool(args, "force");
  const intervalMs = parseDuration(flag(args, "interval") ?? "1h");
  const phaseFilter = (flag(args, "phase") as PhaseName | undefined) ?? undefined;

  if (phaseFilter !== undefined && !PHASE_NAMES.includes(phaseFilter)) {
    process.stderr.write(`Unknown --phase ${phaseFilter}. Known: ${PHASE_NAMES.join(", ")}\n`);
    process.exit(2);
  }

  if (async) {
    const req = await enqueueCycleRequest({
      homeDir,
      scope,
      dryRun,
      ...(phaseFilter !== undefined ? { phase: phaseFilter } : {}),
    });
    if (json) process.stdout.write(`${JSON.stringify(req, null, 2)}\n`);
    else
      process.stdout.write(
        `queued cycle ${req.id} (scope=${scope}${phaseFilter ? ` phase=${phaseFilter}` : ""})\n`,
      );
    return;
  }

  do {
    const progress = json ? undefined : createProgressReporter();
    const report = await runCycleNow({
      homeDir,
      rootDir,
      scope,
      dryRun,
      phaseFilter,
      force,
      onProgress: progress,
    });
    printReport(report, { json });
    if (watch) {
      await sleep(intervalMs);
    }
  } while (watch);
}

export async function runCycleNow(opts: {
  homeDir: string;
  rootDir: string;
  scope: string;
  dryRun?: boolean;
  phaseFilter?: PhaseName;
  force?: boolean;
  onProgress?: (event: CycleProgressEvent) => void;
}): Promise<CycleReport> {
  const brain = await openBrain({
    homeDir: opts.homeDir,
    rootDir: opts.rootDir,
    scope: opts.scope,
  });
  try {
    const cycleModel = buildBrainChatModel(
      brain.config,
      "consolidator",
      authDir(opts.homeDir),
    ).model;
    const phases = buildPhases(opts.homeDir, opts.rootDir, opts.scope, cycleModel).filter(
      (p) => opts.phaseFilter === undefined || p.name === opts.phaseFilter,
    );
    return await runCycle({
      context: {
        storage: brain.storage,
        markdownStore: brain.markdownStore,
        dryRun: opts.dryRun === true,
        now: () => Date.now(),
      },
      phases,
      ...(opts.force === true ? { force: true } : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
    });
  } finally {
    await brain.close();
  }
}

export function buildPhases(
  homeDir: string,
  rootDir: string,
  scope: string,
  cycleModel?: Parameters<typeof buildSynthesizeGenerator>[0]["model"],
): Phase[] {
  return [
    linkFixPhase,
    createReflectPhase({
      loadRecentTranscripts: (ctx) =>
        loadRecentEpisodicAsTranscripts(ctx, { lookbackHours: 24, limit: 200 }),
      generate: buildSynthesizeGenerator({
        rootDir,
        scope,
        ...(cycleModel !== undefined ? { model: cycleModel } : {}),
      }),
    }),
    createMemorySynthesizePhase({
      loadRecentTranscripts: (ctx) =>
        loadRecentEpisodicAsTranscripts(ctx, { lookbackHours: 24, limit: 200 }),
      loadRecentSourceInputs: async () =>
        listRecentSourceDocumentRecords(homeDir, 30).map((record) => {
          const envelope = sourceEnvelopeForRecord(record);
          return {
            id: `${record.source.instanceId}:${record.source.externalId}`,
            body: truncateForCycle(renderRecordForMemory(record), 12_000),
            recordedAt: envelope.recordedAt,
            sourceType: "raw" as const,
            envelope: envelope as unknown as Record<string, unknown>,
          };
        }),
      loadRecentReflections: (ctx) => loadRecentReflections(ctx, { lookbackDays: 7, limit: 20 }),
      ...(cycleModel !== undefined
        ? { generate: buildMemorySynthesizeGenerator({ scope, model: cycleModel }) }
        : {}),
    }),
    createDedupPhase(),
    createStalePhase(),
    createPatternsPhase({
      loadRecentReflections: (ctx) => loadRecentReflections(ctx, { lookbackDays: 30, limit: 50 }),
      generate: buildPatternsGenerator({ rootDir, scope }),
      minEvidence: 3,
    }),
  ];
}

function truncateForCycle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.75);
  const tail = maxChars - head - 160;
  return `${text.slice(0, head)}\n\n[... truncated for cycle input: original ${text.length} chars ...]\n\n${text.slice(-Math.max(0, tail))}`;
}

function createProgressReporter(): (event: CycleProgressEvent) => void {
  const interactive = process.stderr.isTTY === true;
  let activeLine = false;

  const writeLine = (line: string): void => {
    if (interactive && activeLine) {
      clearLine(process.stderr, 0);
      cursorTo(process.stderr, 0);
    }
    process.stderr.write(`${line}\n`);
    activeLine = false;
  };

  const writeActive = (line: string): void => {
    if (!interactive) {
      process.stderr.write(`${line}\n`);
      activeLine = false;
      return;
    }
    clearLine(process.stderr, 0);
    cursorTo(process.stderr, 0);
    process.stderr.write(line);
    activeLine = true;
  };

  return (event) => {
    switch (event.type) {
      case "cycle-start":
        writeLine(
          `Starting cycle ${event.runId} (${event.phaseCount} phase${event.phaseCount === 1 ? "" : "s"})`,
        );
        return;
      case "phase-start":
        writeActive(`  … ${event.phase.padEnd(12)} running (${event.index + 1}/${event.total})`);
        return;
      case "phase-end": {
        const tag =
          event.result.status === "ok" ? "✓" : event.result.status === "skipped" ? "·" : "✗";
        writeLine(
          `  ${tag} ${event.result.phase.padEnd(12)} ${event.result.message ?? ""} (${event.result.durationMs}ms)`,
        );
        return;
      }
      case "cycle-end":
        return;
    }
  };
}

function printReport(report: CycleReport, opts: { json: boolean }): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const failed = report.phases.filter((p) => p.status === "failed").length;
  const skipped = report.phases.filter((p) => p.status === "skipped").length;
  const ok = report.phases.length - failed - skipped;
  process.stdout.write(
    `Cycle ${report.runId} finished: ${ok} ok, ${skipped} skipped, ${failed} failed\n`,
  );
}

function parseDuration(input: string): number {
  const m = input.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (m === null) {
    process.stderr.write(`Invalid --interval "${input}". Examples: 30s, 5m, 1h, 12h, 1d\n`);
    process.exit(2);
  }
  const n = Number.parseInt(m[1] as string, 10);
  switch (m[2] ?? "ms") {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return n;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
