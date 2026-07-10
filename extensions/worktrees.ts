import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  type Focusable,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Text,
} from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type Static, Type } from "typebox";

const LINEAR_FLAGS = ["--output", "json", "--compact", "--no-pager", "--quiet"];
const CWD_CHANGE_TYPE = "workflow-cwd-change";
const WORKTREE_CHANGE_TYPE = "workflow-worktree-change";
const MAIN_REPO_CHANGE_TYPE = "workflow-main-repo-change";

let effectiveCwd = process.cwd();
let effectiveBranch: string | undefined;
let sessionSeed: { cwd: string; branch?: string } | undefined;
let activePrCache:
  | { key: string; pr: ActivePr | null; loading: boolean }
  | undefined;

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

type ActivePr = {
  number: number;
  url: string;
};

type PullRequestBranch = {
  number?: number;
  title?: string;
  url?: string;
  headRefName?: string;
};

type LinearIssue = {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  url?: string;
  branchName?: string;
  gitBranchName?: string;
  state?: { name?: string } | string;
  assignee?: { name?: string; email?: string } | string | null;
  priorityLabel?: string;
};

type WorktreeConfig = {
  baseDir: string;
  branchPrefix: string;
  defaultBaseBranch: string;
  defaultIntegrateMode: "squash" | "cherry-pick" | "merge";
  cleanupAfterIntegrate: "ask" | "none" | "worktree" | "branch";
  copyFiles: string[];
  symlinkDirs: string[];
  postCreateHooks: string[];
  postSwitchHooks: string[];
  preYeetChecks: string[];
};

type WorktreeInfo = {
  path: string;
  branch?: string;
  head?: string;
  detached: boolean;
};

const DEFAULT_CONFIG: WorktreeConfig = {
  baseDir: "~/.pi-worktrees",
  branchPrefix: "tvdavies/",
  defaultBaseBranch: "main",
  defaultIntegrateMode: "squash",
  cleanupAfterIntegrate: "ask",
  copyFiles: [".env", ".env.local"],
  symlinkDirs: [],
  postCreateHooks: [],
  postSwitchHooks: [],
  preYeetChecks: [],
};

function output(result: ExecResult) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function stripAnsi(input: string) {
  return input
    .replace(/\x1b\[[0-9;]*m/g, "")
    // Preserve OSC 8 hyperlink labels while removing opener/closer escapes.
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

function sanitizeFooterText(text: string) {
  return stripAnsi(text)
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function visibleWidth(input: string) {
  return stripAnsi(input).length;
}

function truncateToWidth(input: string, width: number, ellipsis = "...") {
  if (visibleWidth(input) <= width) return input;
  const plain = stripAnsi(input);
  if (width <= visibleWidth(ellipsis)) return ellipsis.slice(0, width);
  return `${plain.slice(0, width - visibleWidth(ellipsis))}${ellipsis}`;
}

function terminalLink(label: string, url: string) {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

function formatTokens(count: number) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function assertOk(result: ExecResult, message: string) {
  if (result.code !== 0)
    throw new Error(`${message}\n${output(result)}`.trim());
}

function expandHome(path: string) {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;
}

function slug(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
}

function shellQuote(input: string) {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

function stashRecoveryInstructions(repoPath: string, stashHash?: string) {
  return stashHash
    ? `Uncommitted changes were stashed as ${stashHash}. Recover with: git -C ${shellQuote(repoPath)} stash apply ${stashHash}`
    : `Uncommitted changes may have been stashed. Check with: git -C ${shellQuote(repoPath)} stash list`;
}

function parseFlags(args: string) {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const flags = new Set(parts.filter((part) => part.startsWith("--")));
  const positional = parts.filter((part) => !part.startsWith("--"));
  return { flags, positional };
}

function getConfig(): WorktreeConfig {
  const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      worktrees?: Partial<WorktreeConfig>;
    };
    return { ...DEFAULT_CONFIG, ...(settings.worktrees ?? {}) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function execOk(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  cwd: string,
  message: string,
) {
  const result = await pi.exec(command, args, { cwd });
  assertOk(result, message);
  return result.stdout.trim();
}

function applyEffectiveStateEntry(entry: unknown) {
  const candidate = entry as
    | {
        type?: unknown;
        customType?: unknown;
        data?: { cwd?: unknown; branch?: unknown };
      }
    | undefined;
  if (candidate?.type !== "custom") return;

  if (candidate.customType === CWD_CHANGE_TYPE) {
    const cwd = candidate.data?.cwd;
    if (typeof cwd === "string" && existsSync(cwd)) effectiveCwd = cwd;
  }

  if (candidate.customType === WORKTREE_CHANGE_TYPE) {
    const cwd = candidate.data?.cwd;
    if (typeof cwd === "string" && existsSync(cwd)) effectiveCwd = cwd;
    effectiveBranch =
      typeof candidate.data?.branch === "string"
        ? candidate.data.branch
        : undefined;
  }
}

function restoreEffectiveState(ctx: {
  sessionManager: ExtensionCommandContext["sessionManager"];
  cwd: string;
}) {
  effectiveCwd = sessionSeed?.cwd ?? ctx.cwd;
  effectiveBranch = sessionSeed?.branch;

  // Worktree state is session-local. This prevents a Pi window launched from
  // the same repo from changing the cwd of another window.
  for (const entry of ctx.sessionManager.getBranch()) {
    applyEffectiveStateEntry(entry);
  }
}

function restoreEffectiveStateFromSessionFile(sessionFile: string) {
  try {
    const previousCwd = effectiveCwd;
    const previousBranch = effectiveBranch;
    let restored = false;

    for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const beforeCwd = effectiveCwd;
      const beforeBranch = effectiveBranch;
      applyEffectiveStateEntry(JSON.parse(line));
      if (effectiveCwd !== beforeCwd || effectiveBranch !== beforeBranch) {
        restored = true;
      }
    }

    if (!restored) {
      effectiveCwd = previousCwd;
      effectiveBranch = previousBranch;
    }
    return restored;
  } catch {
    return false;
  }
}

function sessionHasWorktreeEntries(
  sessionManager: ExtensionCommandContext["sessionManager"],
) {
  return sessionManager.getBranch().some((entry) => {
    const candidate = entry as { type?: unknown; customType?: unknown };
    return (
      candidate.type === "custom" &&
      (candidate.customType === CWD_CHANGE_TYPE ||
        candidate.customType === WORKTREE_CHANGE_TYPE)
    );
  });
}

function getEffectiveCwd(ctx: ExtensionCommandContext) {
  restoreEffectiveState(ctx);
  return effectiveCwd;
}

function bashSingleQuote(str: string) {
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

function launchGhostty(cwd: string) {
  const command = ["ghostty", "ghosty"].find(
    (candidate) => spawnSync("sh", ["-lc", `command -v ${candidate}`]).status === 0,
  );
  if (!command) throw new Error("Could not find ghostty on PATH.");

  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ":0",
    XAUTHORITY: process.env.XAUTHORITY || join(homedir(), ".Xauthority"),
    XDG_RUNTIME_DIR:
      process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ||
      `unix:path=/run/user/${process.getuid?.() ?? 1000}/bus`,
  };
  const child = spawn(command, [], {
    cwd,
    env,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
  return command;
}

function resolveToolPath(path: string | undefined) {
  if (!path || isAbsolute(path)) return path;
  return resolve(effectiveCwd, path);
}

async function getGitRoot(pi: ExtensionAPI, cwd: string) {
  return execOk(
    pi,
    "git",
    ["rev-parse", "--show-toplevel"],
    cwd,
    "Could not find git root.",
  );
}

async function getMainWorktreePath(pi: ExtensionAPI, cwd: string) {
  const gitRoot = await getGitRoot(pi, cwd);
  const worktrees = await listWorktrees(pi, gitRoot);
  const main = worktrees.find((wt) => !wt.path.includes("/.pi-worktrees/"));
  return main?.path ?? gitRoot;
}

async function getCurrentBranch(pi: ExtensionAPI, cwd = process.cwd()) {
  const result = await pi.exec("git", ["branch", "--show-current"], { cwd });
  assertOk(result, "Could not determine current branch.");
  return result.stdout.trim();
}

async function getDefaultBranch(
  pi: ExtensionAPI,
  repoRoot: string,
  config: WorktreeConfig,
) {
  const result = await pi.exec(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    { cwd: repoRoot },
  );
  if (result.code === 0 && result.stdout.trim().startsWith("origin/"))
    return result.stdout.trim().replace(/^origin\//, "");
  return config.defaultBaseBranch;
}

async function repoSlug(pi: ExtensionAPI, repoRoot: string) {
  const result = await pi.exec(
    "git",
    ["config", "--get", "remote.origin.url"],
    { cwd: repoRoot },
  );
  const remote = result.code === 0 ? result.stdout.trim() : "";
  const name = remote
    ? remote
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .filter(Boolean)
        .pop()
    : undefined;
  return slug(name || basename(repoRoot));
}

async function getIssue(pi: ExtensionAPI, issueId: string) {
  const result = await pi.exec("linear-cli", [
    "issues",
    "get",
    issueId,
    "--comments",
    ...LINEAR_FLAGS,
  ]);
  assertOk(result, `Could not fetch Linear issue ${issueId}.`);
  const parsed = JSON.parse(result.stdout) as LinearIssue | LinearIssue[];
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function branchForIssue(
  issue: LinearIssue,
  fallbackIssueId: string,
  config: WorktreeConfig,
) {
  const raw =
    issue.branchName ??
    issue.gitBranchName ??
    `${issue.identifier ?? fallbackIssueId}-${slug(issue.title ?? "work")}`;
  return raw.startsWith(config.branchPrefix)
    ? raw
    : `${config.branchPrefix}${slug(raw)}`;
}

function normaliseBranchName(input: string) {
  return input.trim().replace(/^origin\//, "");
}

function isPullRequestNumber(input: string) {
  return /^#?\d+$/.test(input.trim());
}

async function branchForPullRequest(
  pi: ExtensionAPI,
  repoRoot: string,
  input: string,
) {
  const prNumber = input.trim().replace(/^#/, "");
  const result = await pi.exec(
    "gh",
    ["pr", "view", prNumber, "--json", "number,title,url,headRefName"],
    { cwd: repoRoot },
  );
  assertOk(result, `Could not fetch PR #${prNumber}.`);
  const parsed = JSON.parse(result.stdout) as PullRequestBranch;
  if (!parsed.headRefName)
    throw new Error(`PR #${prNumber} did not include a head branch name.`);
  return { branch: normaliseBranchName(parsed.headRefName), pr: parsed };
}

function worktreeNameFromBranch(branch: string, config: WorktreeConfig) {
  return slug(
    branch.startsWith(config.branchPrefix)
      ? branch.slice(config.branchPrefix.length)
      : branch,
  );
}

function shortWorktreeId(branch: string) {
  return createHash("sha1")
    .update(`${branch}:${Date.now()}:${randomBytes(4).toString("hex")}`)
    .digest("hex")
    .slice(0, 8);
}

function worktreeLabel(wt: WorktreeInfo, config: WorktreeConfig) {
  const name = basename(wt.path);
  const branch = wt.branch ?? "detached";
  const suffix = isManagedWorktree(wt.path, config) ? name : wt.path;
  return `${branch} — ${suffix}`;
}

function pathFromWorktreeLabel(label: string) {
  return label.split(" — ").at(-1);
}

type KeybindingsLike = {
  matches: (keyData: string, action: string) => boolean;
};

type SearchableSelectDialogOptions = {
  title: string;
  items: SelectItem[];
  getMaxVisible: () => number;
  keybindings: KeybindingsLike;
  theme: SelectListTheme;
  getSearchText: (item: SelectItem) => string;
  formatTitle: (text: string) => string;
  formatHint: (text: string) => string;
  formatBorder: (text: string) => string;
  requestRender: () => void;
  onSelect: (item: SelectItem) => void;
  onCancel: () => void;
};

class SearchableSelectDialog extends Container implements Focusable {
  private readonly searchInput = new Input();
  private readonly listContainer = new Container();
  private selectList!: SelectList;
  private filteredItems: SelectItem[] = [];
  private selectedIndex = 0;
  private listMaxVisible = 1;
  private _focused = false;

  get focused() {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(private readonly options: SearchableSelectDialogOptions) {
    super();

    this.addChild(new DynamicBorder(options.formatBorder));
    this.addChild(new Text(options.formatTitle(options.title), 1, 0));
    this.addChild(
      new Text(options.formatHint("Type to filter by branch, folder, or path"), 1, 0),
    );
    this.addChild(this.searchInput);
    this.addChild(this.listContainer);
    this.addChild(
      new Text(options.formatHint("↑↓ navigate • enter switch • esc cancel"), 1, 0),
    );
    this.addChild(new DynamicBorder(options.formatBorder));

    this.searchInput.onSubmit = () => {
      const item = this.selectList.getSelectedItem();
      if (item) this.options.onSelect(item);
    };

    this.rebuildList("");
  }

  private getListMaxVisible(items: SelectItem[]) {
    return Math.max(
      1,
      Math.min(this.options.getMaxVisible(), Math.max(items.length, 1)),
    );
  }

  private buildList(items: SelectItem[]) {
    this.listMaxVisible = this.getListMaxVisible(items);
    const list = new SelectList(items, this.listMaxVisible, this.options.theme, {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 48,
    });

    this.selectedIndex = Math.max(
      0,
      Math.min(this.selectedIndex, Math.max(items.length - 1, 0)),
    );
    list.setSelectedIndex(this.selectedIndex);
    list.onSelect = this.options.onSelect;
    list.onCancel = this.options.onCancel;
    return list;
  }

  private rebuildList(query: string, resetSelection = false) {
    this.filteredItems = query.trim()
      ? fuzzyFilter(this.options.items, query, this.options.getSearchText)
      : this.options.items;

    if (resetSelection) this.selectedIndex = 0;
    this.selectList = this.buildList(this.filteredItems);
    this.listContainer.clear();
    this.listContainer.addChild(this.selectList);
  }

  private moveSelection(delta: number) {
    if (this.filteredItems.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex + delta + this.filteredItems.length) %
      this.filteredItems.length;
    this.selectList.setSelectedIndex(this.selectedIndex);
  }

  private selectCurrent() {
    const item = this.filteredItems[this.selectedIndex];
    if (item) this.options.onSelect(item);
  }

  override render(width: number) {
    if (this.getListMaxVisible(this.filteredItems) !== this.listMaxVisible) {
      this.rebuildList(this.searchInput.getValue());
    }
    return super.render(width);
  }

  handleInput(data: string) {
    const keybindings = this.options.keybindings;
    const isCancel = keybindings.matches(data, "tui.select.cancel");
    const isUp = keybindings.matches(data, "tui.select.up");
    const isDown = keybindings.matches(data, "tui.select.down");
    const isConfirm = keybindings.matches(data, "tui.select.confirm");

    if (isCancel) {
      this.options.onCancel();
      this.options.requestRender();
      return;
    }

    if (isUp || isDown || isConfirm) {
      if (isUp) this.moveSelection(-1);
      if (isDown) this.moveSelection(1);
      if (isConfirm) this.selectCurrent();
      this.options.requestRender();
      return;
    }

    const before = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    const after = this.searchInput.getValue();

    if (after !== before) this.rebuildList(after, true);
    this.options.requestRender();
  }
}

function worktreeSelectItem(
  wt: WorktreeInfo,
  config: WorktreeConfig,
): SelectItem {
  const branch = wt.branch ?? "detached";
  const suffix = isManagedWorktree(wt.path, config) ? basename(wt.path) : wt.path;

  return {
    value: resolve(wt.path),
    label: branch,
    description: suffix,
  };
}

async function selectWorktreeFromUi(
  ctx: ExtensionCommandContext,
  worktrees: WorktreeInfo[],
  config: WorktreeConfig,
) {
  const items = worktrees.map((wt) => worktreeSelectItem(wt, config));
  const worktreeByPath = new Map(worktrees.map((wt) => [resolve(wt.path), wt]));

  const selectedPath = await ctx.ui.custom<string | null>(
    (tui, theme, keybindings, done) => {
      const getMaxVisible = () => {
        const overlayRows = Math.max(
          1,
          Math.min(Math.floor(tui.terminal.rows * 0.8), tui.terminal.rows - 4),
        );
        return Math.max(1, overlayRows - 8);
      };

      return new SearchableSelectDialog({
        title: "Switch to worktree",
        items,
        getMaxVisible,
        keybindings,
        theme: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: () => theme.fg("warning", "  No matching worktrees"),
        },
        getSearchText: (item) =>
          `${item.label} ${item.description ?? ""} ${item.value} ${basename(item.value)}`,
        formatTitle: (text) => theme.fg("accent", theme.bold(text)),
        formatHint: (text) => theme.fg("dim", text),
        formatBorder: (text) => theme.fg("accent", text),
        requestRender: () => tui.requestRender(),
        onSelect: (item) => done(item.value),
        onCancel: () => done(null),
      });
    },
    {
      overlay: true,
      overlayOptions: {
        width: "90%",
        minWidth: 50,
        maxHeight: "80%",
        margin: 2,
      },
    },
  );

  return selectedPath ? worktreeByPath.get(resolve(selectedPath)) : undefined;
}

async function listWorktrees(
  pi: ExtensionAPI,
  repoRoot: string,
): Promise<WorktreeInfo[]> {
  const result = await pi.exec("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
  });
  assertOk(result, "Could not list git worktrees.");
  return result.stdout
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const path =
        lines
          .find((line) => line.startsWith("worktree "))
          ?.replace(/^worktree /, "") ?? "";
      const branch = lines
        .find((line) => line.startsWith("branch "))
        ?.replace(/^branch refs\/heads\//, "");
      const head = lines
        .find((line) => line.startsWith("HEAD "))
        ?.replace(/^HEAD /, "");
      return { path, branch, head, detached: !branch };
    })
    .filter((item) => item.path);
}

async function findWorktree(
  pi: ExtensionAPI,
  repoRoot: string,
  branchOrName: string,
  config: WorktreeConfig,
) {
  const target = branchOrName.startsWith(config.branchPrefix)
    ? branchOrName
    : `${config.branchPrefix}${branchOrName}`;
  const targetName = worktreeNameFromBranch(target, config);
  const worktrees = await listWorktrees(pi, repoRoot);
  return worktrees.find(
    (item) =>
      item.branch === target ||
      item.branch === branchOrName ||
      worktreeNameFromBranch(item.branch ?? basename(item.path), config) ===
        targetName ||
      basename(item.path) === branchOrName,
  );
}

function isManagedWorktree(path: string, config: WorktreeConfig) {
  const managedRoot = resolve(expandHome(config.baseDir));
  return resolve(path).startsWith(`${managedRoot}/`);
}

async function copyConfiguredFiles(
  pi: ExtensionAPI,
  sourceRoot: string,
  worktreePath: string,
  config: WorktreeConfig,
) {
  for (const file of config.copyFiles) {
    if (!existsSync(join(sourceRoot, file))) continue;
    await pi.exec(
      "cp",
      ["-R", join(sourceRoot, file), join(worktreePath, file)],
      { cwd: sourceRoot },
    );
  }
  for (const dir of config.symlinkDirs) {
    const source = join(sourceRoot, dir);
    const target = join(worktreePath, dir);
    if (!existsSync(source) || existsSync(target)) continue;
    await pi.exec("ln", ["-s", source, target], { cwd: sourceRoot });
  }
}

async function runWorktreeHooks(
  pi: ExtensionAPI,
  hooks: string[],
  sourceRoot: string,
  worktreePath: string,
  label: string,
) {
  for (const hook of hooks) {
    const command = `export PI_WORKTREE_SOURCE_ROOT=${shellQuote(sourceRoot)} PI_WORKTREE_PATH=${shellQuote(worktreePath)}; ${hook}`;
    const result = await pi.exec("bash", ["-lc", command], {
      cwd: worktreePath,
    });
    assertOk(result, `Worktree ${label} hook failed: ${hook}`);
  }
}

async function chooseBaseRef(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repoRoot: string,
  explicitBase: string | undefined,
  config: WorktreeConfig,
) {
  if (explicitBase) return explicitBase;
  const defaultBranch = await getDefaultBranch(pi, repoRoot, config);
  const currentBranch = await getCurrentBranch(pi, repoRoot).catch(
    () => "HEAD",
  );
  const choice = await ctx.ui.select("Create worktree from", [
    `Latest origin/${defaultBranch}`,
    `Current branch (${currentBranch})`,
    "Specific branch/ref…",
  ]);
  if (choice === `Current branch (${currentBranch})`) return currentBranch;
  if (choice === "Specific branch/ref…") {
    const ref = await ctx.ui.input(
      "Base ref",
      "Branch, tag, or commit to branch from",
    );
    if (!ref) return undefined;
    return ref.trim();
  }
  return `origin/${defaultBranch}`;
}

async function fetchBaseRef(
  pi: ExtensionAPI,
  repoRoot: string,
  baseRef: string,
) {
  if (baseRef.startsWith("origin/")) {
    const branch = baseRef.replace(/^origin\//, "");
    await execOk(
      pi,
      "git",
      ["fetch", "origin", branch],
      repoRoot,
      `Could not fetch latest ${baseRef}.`,
    );
    return;
  }
  await pi.exec("git", ["fetch", "origin"], { cwd: repoRoot });
}

async function createManagedWorktreePath(
  pi: ExtensionAPI,
  repoRoot: string,
  branchName: string,
  config: WorktreeConfig,
) {
  const root = join(
    resolve(expandHome(config.baseDir)),
    await repoSlug(pi, repoRoot),
  );
  await mkdir(root, { recursive: true });
  let worktreePath = join(root, shortWorktreeId(branchName));
  while (existsSync(worktreePath))
    worktreePath = join(root, shortWorktreeId(branchName));
  return worktreePath;
}

async function finishManagedWorktreeCreate(
  pi: ExtensionAPI,
  repoRoot: string,
  worktreePath: string,
  config: WorktreeConfig,
) {
  await copyConfiguredFiles(pi, repoRoot, worktreePath, config);
  await runWorktreeHooks(
    pi,
    config.postCreateHooks,
    repoRoot,
    worktreePath,
    "post-create",
  );
}

async function ensureWorktree(
  pi: ExtensionAPI,
  repoRoot: string,
  branchName: string,
  baseRef: string,
  config: WorktreeConfig,
) {
  const existing = await findWorktree(pi, repoRoot, branchName, config);
  if (existing && existsSync(existing.path)) return existing.path;

  const worktreePath = await createManagedWorktreePath(
    pi,
    repoRoot,
    branchName,
    config,
  );

  await fetchBaseRef(pi, repoRoot, baseRef);
  let result = await pi.exec(
    "git",
    ["worktree", "add", worktreePath, branchName],
    { cwd: repoRoot },
  );
  if (result.code !== 0) {
    result = await pi.exec(
      "git",
      ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      { cwd: repoRoot },
    );
  }
  assertOk(result, `Could not create worktree for ${branchName}.`);
  await finishManagedWorktreeCreate(pi, repoRoot, worktreePath, config);
  return worktreePath;
}

async function ensureAdoptedWorktree(
  pi: ExtensionAPI,
  repoRoot: string,
  branchName: string,
  config: WorktreeConfig,
) {
  const branch = normaliseBranchName(branchName);
  const existing = await findWorktree(pi, repoRoot, branch, config);
  if (existing && existsSync(existing.path)) return existing.path;

  const worktreePath = await createManagedWorktreePath(
    pi,
    repoRoot,
    branch,
    config,
  );

  await pi.exec(
    "git",
    ["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`],
    { cwd: repoRoot },
  );
  let result = await pi.exec("git", ["worktree", "add", worktreePath, branch], {
    cwd: repoRoot,
  });
  if (result.code !== 0) {
    result = await pi.exec(
      "git",
      ["worktree", "add", "-b", branch, worktreePath, `origin/${branch}`],
      { cwd: repoRoot },
    );
  }
  assertOk(result, `Could not create worktree for ${branch}.`);
  await finishManagedWorktreeCreate(pi, repoRoot, worktreePath, config);
  return worktreePath;
}

async function switchCwd(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  worktreePath: string,
  branch?: string,
  kickoff?: string,
) {
  const resolvedWorktreePath = resolve(worktreePath);
  const config = getConfig();
  const repoRoot = await getGitRoot(pi, resolvedWorktreePath).catch(
    () => resolvedWorktreePath,
  );
  await runWorktreeHooks(
    pi,
    config.postSwitchHooks,
    repoRoot,
    resolvedWorktreePath,
    "post-switch",
  );
  effectiveCwd = resolvedWorktreePath;
  effectiveBranch = branch;
  sessionSeed = { cwd: resolvedWorktreePath, branch };
  pi.appendEntry(CWD_CHANGE_TYPE, { cwd: resolvedWorktreePath });
  pi.appendEntry(WORKTREE_CHANGE_TYPE, { cwd: resolvedWorktreePath, branch });
  if (branch)
    ctx.ui.setStatus("worktree", ctx.ui.theme.fg("accent", `wt ${branch}`));
  else ctx.ui.setStatus("worktree", undefined);
  ctx.ui.notify(`Working in ${resolvedWorktreePath}`, "info");
  if (kickoff) pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
}

function issueContext(
  issue: LinearIssue,
  branchName: string,
  worktreePath: string,
) {
  const state =
    typeof issue.state === "string" ? issue.state : issue.state?.name;
  const assignee =
    typeof issue.assignee === "string"
      ? issue.assignee
      : (issue.assignee?.name ?? issue.assignee?.email);
  return [
    `We are starting work in git worktree: ${worktreePath}`,
    `Branch: ${branchName}`,
    issue.identifier ? `Issue: ${issue.identifier}` : undefined,
    issue.title ? `Title: ${issue.title}` : undefined,
    state ? `State: ${state}` : undefined,
    assignee ? `Assignee: ${assignee}` : undefined,
    issue.priorityLabel ? `Priority: ${issue.priorityLabel}` : undefined,
    issue.url ? `URL: ${issue.url}` : undefined,
    issue.description ? `\nDescription:\n${issue.description}` : undefined,
    "\nCompletion contract:",
    "- The deliverable is a GitHub pull request ready for review, not just a local implementation.",
    "- Implement the ticket, run the relevant checks, inspect the final diff, commit all intended changes, and push this branch.",
    "- Create a ready-for-review (non-draft) PR, or update the existing PR for this branch. Do not stop after coding while changes are uncommitted, unpushed, or lack a PR.",
    "- Use a clear title that identifies the ticket and change. Write a well-documented PR body with the ticket link, summary, implementation details and key decisions, validation commands and results, risks or caveats, and screenshots for UI changes.",
    "- Keep the PR focused on this ticket. Before finishing, verify the working tree is clean and return the PR URL.",
    "- If a genuine blocker prevents committing, pushing, or creating the PR, report the exact blocker and the commands attempted instead of silently stopping.",
  ]
    .filter(Boolean)
    .join("\n");
}

function adoptContext(
  branchName: string,
  worktreePath: string,
  pr?: PullRequestBranch,
) {
  return [
    `We are adopting an existing branch in git worktree: ${worktreePath}`,
    `Branch: ${branchName}`,
    pr?.number ? `PR: #${pr.number}` : undefined,
    pr?.title ? `Title: ${pr.title}` : undefined,
    pr?.url ? `URL: ${pr.url}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

async function statusLine(pi: ExtensionAPI, cwd: string) {
  const branch = await getCurrentBranch(pi, cwd).catch(() => "detached");
  const short = await pi.exec("git", ["status", "--short"], { cwd });
  const files = short.stdout.trim()
    ? short.stdout.trim().split("\n").length
    : 0;
  return `${branch} · ${files} changed file${files === 1 ? "" : "s"}`;
}

function getActivePr(
  pi: ExtensionAPI,
  cwd: string,
  branch: string | null,
  onChange: () => void,
) {
  if (!branch || branch === "detached") return null;
  const key = `${cwd}:${branch}`;
  if (activePrCache?.key === key) return activePrCache.pr;

  activePrCache = { key, pr: null, loading: true };
  void pi
    .exec(
      "gh",
      ["pr", "view", branch, "--json", "number,url"],
      { cwd },
    )
    .then((result) => {
      if (activePrCache?.key !== key) return;
      if (result.code !== 0 || !result.stdout.trim()) {
        activePrCache = { key, pr: null, loading: false };
        onChange();
        return;
      }
      const parsed = JSON.parse(result.stdout) as ActivePr;
      activePrCache = {
        key,
        pr: parsed.url && parsed.number ? parsed : null,
        loading: false,
      };
      onChange();
    })
    .catch(() => {
      if (activePrCache?.key === key) {
        activePrCache = { key, pr: null, loading: false };
        onChange();
      }
    });
  return null;
}

async function runYeet(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
) {
  const { flags } = parseFlags(args);
  const cwd = getEffectiveCwd(ctx);
  const branch = await getCurrentBranch(pi, cwd);
  if (!branch) throw new Error("Cannot yeet from detached HEAD.");
  const defaultBranch = await getDefaultBranch(
    pi,
    await getGitRoot(pi, cwd),
    getConfig(),
  );
  if (branch === defaultBranch)
    throw new Error(`Refusing to yeet default branch ${defaultBranch}.`);

  const summary = await statusLine(pi, cwd);
  const choice = await ctx.ui.select("Yeet branch?", [
    `Run checks, commit, push, create/update draft PR (${summary})`,
    "Commit + push only",
    "Create/update draft PR only",
    "Cancel",
  ]);
  if (!choice || choice === "Cancel") return;

  const config = getConfig();
  if (!flags.has("--no-checks") && choice.startsWith("Run checks")) {
    for (const check of config.preYeetChecks)
      assertOk(
        await pi.exec("bash", ["-lc", check], { cwd }),
        `Check failed: ${check}`,
      );
  }

  const hasChanges =
    (await pi.exec("git", ["status", "--porcelain"], { cwd })).stdout.trim()
      .length > 0;
  if (hasChanges && !choice.startsWith("Create/update")) {
    await execOk(pi, "git", ["add", "-A"], cwd, "Could not stage changes.");
    const message = `chore: update ${branch.replace(/^.*\//, "")}`;
    await execOk(
      pi,
      "git",
      ["commit", "-m", message],
      cwd,
      "Could not commit changes.",
    );
  }

  if (!choice.startsWith("Create/update")) {
    await execOk(
      pi,
      "git",
      ["push", "-u", "origin", branch],
      cwd,
      "Could not push branch.",
    );
  }
  if (choice === "Commit + push only") return;

  const existingPr = await pi.exec(
    "gh",
    ["pr", "view", branch, "--json", "url", "--jq", ".url"],
    { cwd },
  );
  if (existingPr.code === 0 && existingPr.stdout.trim()) {
    ctx.ui.notify(`PR already exists: ${existingPr.stdout.trim()}`, "info");
    return;
  }

  const title = branch
    .replace(/^.*\//, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const log = await pi.exec(
    "git",
    ["log", `origin/${defaultBranch}..HEAD`, "--oneline"],
    { cwd },
  );
  const body = [
    `## Summary`,
    log.stdout.trim() || "Changes from this branch.",
    "",
    "## Validation",
    flags.has("--no-checks")
      ? "Not run."
      : config.preYeetChecks.length
        ? config.preYeetChecks.map((x) => `- ${x}`).join("\n")
        : "Not run.",
  ].join("\n");
  await execOk(
    pi,
    "gh",
    [
      "pr",
      "create",
      "--draft",
      "--base",
      defaultBranch,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ],
    cwd,
    "Could not create draft PR.",
  );
}

async function withLoading<T>(
  ctx: ExtensionCommandContext,
  message: string,
  fn: () => Promise<T>,
) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  let currentMessage = message;
  let timer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;
  const setMessage = ctx.ui.setWorkingMessage.bind(ctx.ui);
  ctx.ui.setWorkingVisible(false);
  ctx.ui.setWorkingMessage = (next?: string) => {
    currentMessage = next || message;
    requestRender?.();
  };
  ctx.ui.setStatus("workflow", ctx.ui.theme.fg("accent", message));
  ctx.ui.setWidget(
    "workflow-loading",
    (tui, theme) => {
      requestRender = () => tui.requestRender();
      timer ??= setInterval(() => {
        frame = (frame + 1) % frames.length;
        tui.requestRender();
      }, 80);
      return {
        render: () => [
          "",
          ` ${theme.fg("accent", frames[frame])} ${theme.fg("muted", currentMessage)}`,
          "",
        ],
        invalidate() {},
      };
    },
    { placement: "aboveEditor" },
  );
  try {
    return await fn();
  } finally {
    if (timer) clearInterval(timer);
    ctx.ui.setWorkingMessage = setMessage;
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingVisible(true);
    ctx.ui.setWidget("workflow-loading", undefined);
    ctx.ui.setStatus("workflow", undefined);
  }
}

async function cleanupIntegrated(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repoRoot: string,
  worktreePath: string,
  branch: string,
  config: WorktreeConfig,
) {
  let action = config.cleanupAfterIntegrate;
  if (action === "ask") {
    const choice = await ctx.ui.select("Clean up integrated worktree?", [
      "Remove worktree + local branch",
      "Remove worktree only",
      "Keep everything",
    ]);
    action =
      choice === "Remove worktree + local branch"
        ? "branch"
        : choice === "Remove worktree only"
          ? "worktree"
          : "none";
  }
  if (action === "none") return;
  await pi.exec("git", ["worktree", "remove", worktreePath], { cwd: repoRoot });
  if (action === "branch")
    await pi.exec("git", ["branch", "-d", branch], { cwd: repoRoot });
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  restoreEffectiveState(ctx);
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsub = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsub,
      invalidate() {},
      render(width: number): string[] {
        restoreEffectiveState(ctx);
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        let totalCost = 0;
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            totalInput += entry.message.usage.input;
            totalOutput += entry.message.usage.output;
            totalCacheRead += entry.message.usage.cacheRead;
            totalCacheWrite += entry.message.usage.cacheWrite;
            totalCost += entry.message.usage.cost.total;
          }
        }

        const statuses = footerData.getExtensionStatuses();

        let pwd = effectiveCwd;
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

        const branch = effectiveBranch ?? footerData.getGitBranch() ?? null;
        const activePr = getActivePr(pi, effectiveCwd, branch, () =>
          tui.requestRender(),
        );
        if (branch) pwd = `${pwd} (${branch})`;
        if (activePr)
          pwd = `${pwd} • ${terminalLink(`PR #${activePr.number}`, activePr.url)}`;

        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) pwd = `${pwd} • ${sessionName}`;

        const statsParts: string[] = [];
        if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
        if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
        if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
        if (totalCacheWrite)
          statsParts.push(`W${formatTokens(totalCacheWrite)}`);
        const usingSubscription = ctx.model
          ? ctx.modelRegistry.isUsingOAuth(ctx.model)
          : false;
        if (totalCost || usingSubscription)
          statsParts.push(
            `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
          );

        const contextUsage = ctx.getContextUsage();
        const contextWindow =
          contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent =
          contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
        const contextDisplay =
          contextPercent === "?"
            ? `?/${formatTokens(contextWindow)} (auto)`
            : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
        statsParts.push(
          contextPercentValue > 90
            ? theme.fg("error", contextDisplay)
            : contextPercentValue > 70
              ? theme.fg("warning", contextDisplay)
              : contextDisplay,
        );

        let statsLeft = statsParts.join(" ");
        let statsLeftWidth = visibleWidth(statsLeft);
        if (statsLeftWidth > width) {
          statsLeft = truncateToWidth(statsLeft, width, "...");
          statsLeftWidth = visibleWidth(statsLeft);
        }

        const modelName = ctx.model?.id || "no-model";
        let rightSide = modelName;
        if (ctx.model?.reasoning) {
          const thinking = ctx.model.reasoning ? "thinking" : "";
          rightSide = thinking ? `${modelName} • ${thinking}` : modelName;
        }
        if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
          const withProvider = `(${ctx.model.provider}) ${rightSide}`;
          if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width)
            rightSide = withProvider;
        }

        const rightWidth = visibleWidth(rightSide);
        let statsLine: string;
        if (statsLeftWidth + 2 + rightWidth <= width) {
          statsLine =
            statsLeft +
            " ".repeat(width - statsLeftWidth - rightWidth) +
            rightSide;
        } else {
          const available = width - statsLeftWidth - 2;
          if (available > 0) {
            const truncatedRight = truncateToWidth(rightSide, available, "");
            statsLine =
              statsLeft +
              " ".repeat(
                Math.max(
                  0,
                  width - statsLeftWidth - visibleWidth(truncatedRight),
                ),
              ) +
              truncatedRight;
          } else {
            statsLine = statsLeft;
          }
        }

        const lines = [
          theme.fg("dim", truncateToWidth(pwd, width, "...")),
          theme.fg("dim", statsLeft) +
            theme.fg("dim", statsLine.slice(statsLeft.length)),
        ];

        const extraStatuses = Array.from(statuses.entries())
          .filter(([key]) => key !== "cwd" && key !== "worktree")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => sanitizeFooterText(text));
        if (extraStatuses.length)
          lines.push(
            truncateToWidth(
              extraStatuses.join(" "),
              width,
              theme.fg("dim", "..."),
            ),
          );
        return lines;
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    const commandCtx = ctx as ExtensionCommandContext;
    restoreEffectiveState(commandCtx);

    // `/new` should inherit the current window's worktree cwd from the session
    // it replaced, but never from a process-global or launch-cwd sidecar.
    if (
      event.reason === "new" &&
      !sessionHasWorktreeEntries(commandCtx.sessionManager) &&
      event.previousSessionFile &&
      restoreEffectiveStateFromSessionFile(event.previousSessionFile) &&
      resolve(effectiveCwd) !== resolve(commandCtx.cwd)
    ) {
      sessionSeed = { cwd: effectiveCwd, branch: effectiveBranch };
      pi.appendEntry(CWD_CHANGE_TYPE, { cwd: effectiveCwd });
      pi.appendEntry(WORKTREE_CHANGE_TYPE, {
        cwd: effectiveCwd,
        branch: effectiveBranch,
      });
    }

    installFooter(pi, commandCtx);
  });
  pi.on("session_tree", (_event, ctx) => {
    sessionSeed = undefined;
    restoreEffectiveState(ctx);
    installFooter(pi, ctx as ExtensionCommandContext);
  });

  pi.on("before_agent_start", (event) => {
    return {
      systemPrompt: event.systemPrompt.replace(
        /Current working directory: .+/,
        `Current working directory: ${effectiveCwd}`,
      ),
    };
  });

  pi.on("tool_call", (event) => {
    const input = event.input as Record<string, unknown>;
    if (event.toolName === "bash" && typeof input.command === "string") {
      input.command = `cd ${bashSingleQuote(effectiveCwd)} && ${input.command}`;
      return;
    }
    if (["read", "write", "edit"].includes(event.toolName)) {
      const path = input.path ?? input.file_path;
      if (typeof path === "string") {
        const resolved = resolveToolPath(path);
        if ("path" in input) input.path = resolved;
        if ("file_path" in input) input.file_path = resolved;
      }
      return;
    }
    if (["ls", "find", "grep"].includes(event.toolName)) {
      input.path = resolveToolPath(
        typeof input.path === "string" ? input.path : ".",
      );
    }
  });

  pi.registerCommand("t", {
    description: "Open a new Ghostty terminal in Pi's current worktree directory",
    handler: async (_args, ctx) => {
      const cwd = getEffectiveCwd(ctx);
      const command = launchGhostty(cwd);
      ctx.ui.notify(`Launched ${command} in ${cwd}`, "info");
    },
  });

  pi.registerCommand("wt-new", {
    description:
      "Create a git worktree under ~/.worktrees and switch Pi into it",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const { positional } = parseFlags(args);
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const name =
        positional[0] ??
        (await ctx.ui.input(
          "Worktree name",
          "Name for the new worktree/branch",
        ));
      if (!name) return;
      const base = await chooseBaseRef(
        pi,
        ctx,
        repoRoot,
        positional[1],
        config,
      );
      if (!base) return;
      const branch = name.startsWith(config.branchPrefix)
        ? name
        : `${config.branchPrefix}${slug(name)}`;
      await withLoading(ctx, `Creating worktree ${branch}…`, async () => {
        const worktreePath = await ensureWorktree(
          pi,
          repoRoot,
          branch,
          base,
          config,
        );
        await switchCwd(pi, ctx, worktreePath, branch);
      });
    },
  });

  pi.registerCommand("wt-fork", {
    description:
      "Create a pi-managed worktree and copy current uncommitted changes into it",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const { positional } = parseFlags(args);
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const name =
        positional[0] ??
        (await ctx.ui.input(
          "Worktree name",
          "Name for the new worktree/branch",
        ));
      if (!name) return;

      const status = (
        await pi.exec("git", ["status", "--porcelain"], { cwd: repoRoot })
      ).stdout.trim();
      if (!status) {
        ctx.ui.notify(
          "No local changes to copy. Use /wt-new instead.",
          "warning",
        );
        return;
      }

      const base = await chooseBaseRef(
        pi,
        ctx,
        repoRoot,
        positional[1],
        config,
      );
      if (!base) return;
      const branch = name.startsWith(config.branchPrefix)
        ? name
        : `${config.branchPrefix}${slug(name)}`;
      const patchPath = join(
        tmpdir(),
        `pi-wt-fork-${randomBytes(6).toString("hex")}.patch`,
      );

      await withLoading(
        ctx,
        `Creating worktree ${branch} with local changes…`,
        async () => {
          const diff = await pi.exec("git", ["diff", "--binary", "HEAD"], {
            cwd: repoRoot,
          });
          assertOk(diff, "Could not capture tracked changes.");
          writeFileSync(patchPath, diff.stdout);

          const untrackedResult = await pi.exec(
            "git",
            ["ls-files", "--others", "--exclude-standard", "-z"],
            { cwd: repoRoot },
          );
          assertOk(untrackedResult, "Could not list untracked files.");
          const untracked = untrackedResult.stdout.split("\0").filter(Boolean);

          const worktreePath = await ensureWorktree(
            pi,
            repoRoot,
            branch,
            base,
            config,
          );

          if (diff.stdout.trim()) {
            const apply = await pi.exec(
              "git",
              ["apply", "--binary", patchPath],
              { cwd: worktreePath },
            );
            assertOk(
              apply,
              `Could not apply local changes patch ${patchPath}.`,
            );
          }

          for (const file of untracked) {
            await mkdir(join(worktreePath, dirname(file)), { recursive: true });
            const copy = await pi.exec(
              "cp",
              ["-R", join(repoRoot, file), join(worktreePath, file)],
              { cwd: repoRoot },
            );
            assertOk(copy, `Could not copy untracked file ${file}.`);
          }

          await switchCwd(pi, ctx, worktreePath, branch);
          ctx.ui.notify(
            `Copied local changes into ${worktreePath}. Recovery patch: ${patchPath}`,
            "info",
          );
        },
      );
    },
  });

  pi.registerCommand("wt-ticket", {
    description:
      "Create a pi-managed worktree for a Linear ticket and switch into it",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const issueId =
        args.trim() ||
        (await ctx.ui.input("Linear ticket", "Ticket ID, e.g. LLE-1234"));
      if (!issueId) return;
      const config = getConfig();
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const issue = await withLoading(ctx, `Loading ${issueId}…`, () =>
        getIssue(pi, issueId),
      );
      const base = await chooseBaseRef(pi, ctx, repoRoot, undefined, config);
      if (!base) return;
      const branch = branchForIssue(issue, issueId, config);
      await withLoading(ctx, `Creating worktree ${branch}…`, async () => {
        const worktreePath = await ensureWorktree(
          pi,
          repoRoot,
          branch,
          base,
          config,
        );
        await switchCwd(
          pi,
          ctx,
          worktreePath,
          branch,
          issueContext(issue, branch, worktreePath),
        );
      });
    },
  });

  pi.registerCommand("wt-adopt", {
    description:
      "Create a pi-managed worktree for an existing PR number or branch and switch into it",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const input =
        args.trim() ||
        (await ctx.ui.input(
          "PR or branch",
          "PR number or existing branch name to adopt",
        ));
      if (!input) return;

      const config = getConfig();
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const resolved = await withLoading(
        ctx,
        isPullRequestNumber(input) ? `Loading PR ${input}…` : `Using ${input}…`,
        async () =>
          isPullRequestNumber(input)
            ? branchForPullRequest(pi, repoRoot, input)
            : { branch: normaliseBranchName(input), pr: undefined },
      );
      const branch = resolved.branch;
      await withLoading(ctx, `Creating worktree ${branch}…`, async () => {
        const worktreePath = await ensureAdoptedWorktree(
          pi,
          repoRoot,
          branch,
          config,
        );
        await switchCwd(
          pi,
          ctx,
          worktreePath,
          branch,
          adoptContext(branch, worktreePath, resolved.pr),
        );
      });
    },
  });

  pi.registerCommand("wt-list", {
    description: "List pi-managed git worktrees",
    handler: async (_args, ctx) => {
      await withLoading(ctx, "Loading worktrees…", async () => {
        const config = getConfig();
        const managedRoot = resolve(expandHome(config.baseDir));
        const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
        const managed = (await listWorktrees(pi, repoRoot)).filter((wt) =>
          resolve(wt.path).startsWith(`${managedRoot}/`),
        );
        const rows = await Promise.all(
          managed.map(async (wt) => {
            const status = await statusLine(pi, wt.path).catch(() => "unknown");
            const changed = status.match(/· (.+)$/)?.[1] ?? status;
            return `${wt.branch ?? "detached"} (${changed}) — ${basename(wt.path)}`;
          }),
        );
        ctx.ui.notify(
          rows.join("\n") || "No pi-managed worktrees found.",
          "info",
        );
      });
    },
  });

  pi.registerCommand("wt-prune", {
    description:
      "Interactively remove clean pi-managed worktrees under worktrees.baseDir",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const managedRoot = resolve(expandHome(config.baseDir));
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const { flags } = parseFlags(args);
      const current = resolve(getEffectiveCwd(ctx));
      const managed = (await listWorktrees(pi, repoRoot)).filter(
        (wt) =>
          resolve(wt.path).startsWith(`${managedRoot}/`) &&
          resolve(wt.path) !== current,
      );
      const clean: WorktreeInfo[] = [];
      const dirty: WorktreeInfo[] = [];
      for (const wt of managed) {
        const status = existsSync(wt.path)
          ? (
              await pi.exec("git", ["status", "--porcelain"], { cwd: wt.path })
            ).stdout.trim()
          : "missing";
        (status ? dirty : clean).push(wt);
      }
      if (clean.length === 0) {
        ctx.ui.notify(
          `No clean pi-managed worktrees to prune. Dirty/skipped: ${dirty.length}`,
          "info",
        );
        return;
      }
      const preview = clean
        .map((wt) => `- ${wt.branch ?? "detached"} — ${wt.path}`)
        .join("\n");
      const ok =
        flags.has("--yes") ||
        (await ctx.ui.confirm(
          "Prune clean pi-managed worktrees?",
          `${preview}\n\nDirty/skipped: ${dirty.length}`,
        ));
      if (!ok) return;
      for (const wt of clean) {
        await pi.exec("git", ["worktree", "remove", wt.path], {
          cwd: repoRoot,
        });
        if (wt.branch?.startsWith(config.branchPrefix))
          await pi.exec("git", ["branch", "-d", wt.branch], { cwd: repoRoot });
      }
      ctx.ui.notify(
        `Pruned ${clean.length} worktree${clean.length === 1 ? "" : "s"}. Dirty/skipped: ${dirty.length}`,
        "info",
      );
    },
  });

  pi.registerCommand("wt-switch", {
    description: "Switch Pi to an existing worktree",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const worktrees = await listWorktrees(pi, repoRoot);
      let selected: WorktreeInfo | undefined;
      if (args.trim()) {
        selected = await findWorktree(pi, repoRoot, args.trim(), config);
      } else {
        selected = await selectWorktreeFromUi(ctx, worktrees, config);
      }
      if (selected) await switchCwd(pi, ctx, selected.path, selected.branch);
    },
  });

  pi.registerCommand("wt-main", {
    description: "Switch Pi to the main repository checkout",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      ctx.ui.setStatus("worktree", undefined);
      await switchCwd(
        pi,
        ctx,
        await getMainWorktreePath(pi, getEffectiveCwd(ctx)),
      );
    },
  });

  pi.registerCommand("wt-status", {
    description: "Show current worktree status",
    handler: async (_args, ctx) => {
      const cwd = getEffectiveCwd(ctx);
      ctx.ui.notify(`${cwd}\n${await statusLine(pi, cwd)}`, "info");
    },
  });

  pi.registerCommand("wt-pull-main", {
    description:
      "Switch to the main checkout, checkout main, and pull latest changes",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await withLoading(ctx, "Updating main…", async () => {
        const config = getConfig();
        const currentCwd = getEffectiveCwd(ctx);
        const mainPath = await getMainWorktreePath(pi, currentCwd);
        const defaultBranch = await getDefaultBranch(pi, mainPath, config);
        const status = (
          await pi.exec("git", ["status", "--porcelain"], { cwd: mainPath })
        ).stdout.trim();
        let stashed = false;
        if (status) {
          ctx.ui.setWorkingMessage("Stashing main changes…");
          await execOk(
            pi,
            "git",
            [
              "stash",
              "push",
              "-u",
              "-m",
              `pi wt-pull-main ${new Date().toISOString()}`,
            ],
            mainPath,
            "Could not stash uncommitted changes in the main checkout.",
          );
          stashed = true;
        }
        ctx.ui.setWorkingMessage(`Fetching origin/${defaultBranch}…`);
        await execOk(
          pi,
          "git",
          ["fetch", "origin", defaultBranch],
          mainPath,
          `Could not fetch origin/${defaultBranch}.`,
        );
        ctx.ui.setWorkingMessage(`Checking out ${defaultBranch}…`);
        await execOk(
          pi,
          "git",
          ["checkout", defaultBranch],
          mainPath,
          `Could not checkout ${defaultBranch}.`,
        );
        ctx.ui.setWorkingMessage(`Pulling origin/${defaultBranch}…`);
        await execOk(
          pi,
          "git",
          ["pull", "--ff-only", "origin", defaultBranch],
          mainPath,
          `Could not pull origin/${defaultBranch}.`,
        );
        if (stashed) {
          ctx.ui.setWorkingMessage("Restoring stashed changes…");
          await execOk(
            pi,
            "git",
            ["stash", "pop"],
            mainPath,
            "Pulled main, but could not re-apply stashed changes. Resolve the stash manually with `git stash list`.",
          );
        }
        await switchCwd(pi, ctx, mainPath);
        ctx.ui.notify(
          `Updated ${defaultBranch} in ${mainPath}${stashed ? " and restored stashed changes" : ""}`,
          "info",
        );
      });
    },
  });

  pi.registerCommand("wt-merge", {
    description: "Integrate current worktree into a target branch",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const { flags, positional } = parseFlags(args);
      const mode = flags.has("--cherry-pick")
        ? "cherry-pick"
        : flags.has("--merge")
          ? "merge"
          : flags.has("--squash")
            ? "squash"
            : config.defaultIntegrateMode;
      const worktreePath = getEffectiveCwd(ctx);
      const branch = await getCurrentBranch(pi, worktreePath);
      const gitRoot = await getGitRoot(pi, worktreePath);
      const target =
        positional[0] ??
        (await ctx.ui.input("Target branch", "Branch to integrate into"));
      if (!target) return;
      await withLoading(ctx, `Integrating ${branch}…`, async () => {
        const dirty = (
          await pi.exec("git", ["status", "--porcelain"], { cwd: worktreePath })
        ).stdout.trim();
        if (dirty)
          throw new Error("Commit or stash worktree changes before /wt-merge.");
        const worktrees = await listWorktrees(pi, gitRoot);
        const targetCheckout =
          worktrees.find((wt) => wt.branch === target)?.path ??
          worktrees.find(
            (wt) =>
              wt.path !== worktreePath &&
              !(wt.branch ?? "").startsWith(config.branchPrefix),
          )?.path ??
          gitRoot;
        await execOk(
          pi,
          "git",
          ["checkout", target],
          targetCheckout,
          `Could not checkout ${target}.`,
        );
        if (mode === "squash")
          await execOk(
            pi,
            "git",
            ["merge", "--squash", branch],
            targetCheckout,
            `Could not squash ${branch}.`,
          );
        else if (mode === "merge")
          await execOk(
            pi,
            "git",
            ["merge", "--no-ff", branch],
            targetCheckout,
            `Could not merge ${branch}.`,
          );
        else
          await execOk(
            pi,
            "git",
            ["cherry-pick", `${target}..${branch}`],
            targetCheckout,
            `Could not cherry-pick ${branch}.`,
          );
        ctx.ui.notify(
          `Integrated ${branch} into ${target} using ${mode}.`,
          "info",
        );
        await cleanupIntegrated(
          pi,
          ctx,
          targetCheckout,
          worktreePath,
          branch,
          config,
        );
        if (flags.has("--yeet")) await runYeet(pi, ctx, "");
        await switchCwd(pi, ctx, targetCheckout, target);
      });
    },
  });

  pi.registerCommand("wt-done", {
    description:
      "Return to the main checkout and remove the current pi-managed worktree",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const { flags } = parseFlags(args);
      const worktreePath = resolve(getEffectiveCwd(ctx));
      if (!isManagedWorktree(worktreePath, config)) {
        return ctx.ui.notify(
          "Current checkout is not a pi-managed worktree.",
          "warning",
        );
      }
      const branch = await getCurrentBranch(pi, worktreePath);
      const mainPath = await getMainWorktreePath(pi, worktreePath);
      const dirty = await execOk(
        pi,
        "git",
        ["status", "--porcelain"],
        worktreePath,
        `Could not check worktree status for ${worktreePath}.`,
      );
      const force = flags.has("--force");
      const willStash = Boolean(dirty && !force);
      const willDiscard = Boolean(dirty && force);
      const branchCleanup = branch?.startsWith(config.branchPrefix)
        ? `\nLocal branch ${branch} will be ${force ? "force-deleted" : "deleted if fully merged"}.`
        : "";
      const dirtyWarning = willDiscard
        ? "Uncommitted changes will be permanently discarded.\n"
        : willStash
          ? "Uncommitted changes will be saved to git stash before removal.\n"
          : "";
      const ok =
        (flags.has("--yes") && !dirty && !force) ||
        (await ctx.ui.confirm(
          "Finish worktree?",
          `${dirtyWarning}Switch back to ${mainPath} and remove ${worktreePath}?${branchCleanup}`,
        ));
      if (!ok) return;

      let stashHash: string | undefined;
      let stashMayExist = false;
      await withLoading(
        ctx,
        `Removing ${branch || basename(worktreePath)}…`,
        async () => {
          try {
            if (willStash) {
              ctx.ui.setWorkingMessage("Stashing uncommitted changes…");
              const previousStash = await pi.exec(
                "git",
                ["rev-parse", "--verify", "--quiet", "stash@{0}"],
                { cwd: worktreePath },
              );
              const previousStashHash =
                previousStash.code === 0 ? previousStash.stdout.trim() : undefined;
              await execOk(
                pi,
                "git",
                [
                  "stash",
                  "push",
                  "-u",
                  "-m",
                  `pi wt-done ${branch || basename(worktreePath)} ${new Date().toISOString()}`,
                ],
                worktreePath,
                "Could not stash uncommitted changes; worktree was not removed.",
              );
              stashMayExist = true;
              const newStashHash = await execOk(
                pi,
                "git",
                ["rev-parse", "--verify", "stash@{0}"],
                worktreePath,
                "Stashed changes but could not record stash ref.",
              );
              if (newStashHash === previousStashHash) {
                throw new Error(
                  "Stash command completed but did not create a new stash; worktree was not removed.",
                );
              }
              stashHash = newStashHash;
              const remaining = await execOk(
                pi,
                "git",
                ["status", "--porcelain"],
                worktreePath,
                "Stashed changes but could not re-check worktree status.",
              );
              if (remaining) {
                throw new Error(
                  "Stashed changes, but the worktree is still dirty; worktree was not removed.",
                );
              }
            }

            ctx.ui.setWorkingMessage(`Switching back to ${mainPath}…`);
            await switchCwd(pi, ctx, mainPath);
            ctx.ui.setWorkingMessage(`Removing ${worktreePath}…`);
            const removeArgs = ["worktree", "remove"];
            if (dirty && force) removeArgs.push("--force");
            removeArgs.push(worktreePath);
            await execOk(
              pi,
              "git",
              removeArgs,
              mainPath,
              `Could not remove worktree ${worktreePath}.`,
            );
            if (branch?.startsWith(config.branchPrefix)) {
              ctx.ui.setWorkingMessage(`Deleting local branch ${branch}…`);
              const deleteArgs = ["branch", force ? "-D" : "-d", branch];
              await execOk(
                pi,
                "git",
                deleteArgs,
                mainPath,
                `Removed worktree, but could not delete local branch ${branch}. It may not be merged; use /wt-abandon ${branch} to force delete it.`,
              );
            }
          } catch (error) {
            if (stashMayExist) {
              const message = error instanceof Error ? error.message : String(error);
              throw new Error(
                `${message}\n\n${stashRecoveryInstructions(mainPath, stashHash)}`,
              );
            }
            throw error;
          }
        },
      );
      const stashDetail = stashHash
        ? ` Stashed uncommitted changes as ${stashHash}; recover with \`git -C ${shellQuote(mainPath)} stash apply ${stashHash}\`.`
        : "";
      ctx.ui.notify(`Finished ${branch || worktreePath}.${stashDetail}`, "info");
    },
  });

  pi.registerCommand("wt-abandon", {
    description: "Remove a pi-managed worktree without integrating it",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const managed = (await listWorktrees(pi, repoRoot)).filter((wt) =>
        isManagedWorktree(wt.path, config),
      );
      let target = args.trim()
        ? await findWorktree(pi, repoRoot, args.trim(), config)
        : undefined;
      if (!target) {
        const selected = await ctx.ui.select(
          "Abandon pi-managed worktree",
          managed.map((wt) => worktreeLabel(wt, config)),
        );
        const selectedSuffix = selected
          ? pathFromWorktreeLabel(selected)
          : undefined;
        target = managed.find(
          (wt) =>
            wt.path === selectedSuffix || basename(wt.path) === selectedSuffix,
        );
      }
      if (!target || !isManagedWorktree(target.path, config))
        return ctx.ui.notify("No pi-managed worktree selected.", "warning");
      const dirty = existsSync(target.path)
        ? (
            await pi.exec("git", ["status", "--porcelain"], {
              cwd: target.path,
            })
          ).stdout.trim()
        : "";
      const ok = await ctx.ui.confirm(
        "Abandon worktree?",
        `${dirty ? "This worktree has uncommitted changes.\n\n" : ""}Remove ${target.path} without integrating ${target.branch ?? "detached"}?`,
      );
      if (!ok) return;
      if (resolve(getEffectiveCwd(ctx)) === resolve(target.path)) {
        ctx.ui.setStatus("worktree", undefined);
        await switchCwd(pi, ctx, repoRoot);
      }
      const remove = await pi.exec(
        "git",
        [
          "worktree",
          "remove",
          dirty ? "--force" : target.path,
          ...(dirty ? [target.path] : []),
        ],
        { cwd: repoRoot },
      );
      assertOk(remove, `Could not remove worktree ${target.path}.`);
      if (target.branch?.startsWith(config.branchPrefix))
        await pi.exec("git", ["branch", "-D", target.branch], {
          cwd: repoRoot,
        });
      ctx.ui.notify(`Abandoned ${target.branch ?? target.path}`, "info");
    },
  });

  pi.registerCommand("yeet", {
    description:
      "Scripted commit, push, and draft PR flow for the current branch",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await withLoading(ctx, "Yeeting current branch…", () =>
        runYeet(pi, ctx, args),
      );
    },
  });

  registerWorktreeTools(pi);
}

// Tool registrations, separated so a slim worker-facing extension can load just
// these (the agent's worktree autonomy) without the session/cwd machinery above.
export function registerWorktreeTools(pi: ExtensionAPI) {
  // --- Agent-callable worktree tools ------------------------------------------
  // The /wt-* commands above are user-driven; these tools give the AGENT the
  // same operations (create / adopt / list / status / merge / remove) so a
  // worker or the resident can manage its own worktrees. Every tool takes an
  // optional `repo` path, so an agent can work across multiple repos in one
  // task — the deterministic per-worker worktree is only a safe default; the
  // agent decides what isolation a task actually needs (e.g. adopt the branch
  // a PR is already checked out on rather than create a fresh one).
  const textResult = (text: string, details?: unknown) => ({
    content: [{ type: "text" as const, text }],
    details,
  });
  const resolveRepo = (repo?: string) => (repo ? resolve(expandHome(repo)) : process.cwd());
  const branchWithPrefix = (name: string, config: WorktreeConfig) => {
    const raw = normaliseBranchName(name);
    return raw.startsWith(config.branchPrefix) ? raw : `${config.branchPrefix}${slug(raw)}`;
  };
  const repoParam = Type.Optional(
    Type.String({
      description: "Path inside the target git repo (any repo — enables multi-repo work). Defaults to the current directory.",
    }),
  );

  const listSchema = Type.Object({ repo: repoParam });
  pi.registerTool({
    name: "worktree_list",
    label: "list worktrees",
    description: "List a repo's git worktrees (path + branch). Check this before creating one so you reuse an existing worktree instead of duplicating it.",
    promptSnippet: "List git worktrees",
    parameters: listSchema,
    async execute(_id, params: Static<typeof listSchema>) {
      try {
        const repoRoot = await getGitRoot(pi, resolveRepo(params.repo));
        const wts = await listWorktrees(pi, repoRoot);
        const text = wts.length ? wts.map((w) => `${w.branch ?? "(detached)"}  ${w.path}`).join("\n") : "No worktrees.";
        return textResult(text, { worktrees: wts });
      } catch (e) {
        return textResult(`worktree_list failed: ${(e as Error).message}`, { ok: false });
      }
    },
  });

  const newSchema = Type.Object({
    name: Type.String({ description: "Branch/work name. Prefixed automatically if it lacks the configured prefix." }),
    base: Type.Optional(Type.String({ description: "Base ref to branch from (default: latest origin default branch)." })),
    repo: repoParam,
  });
  pi.registerTool({
    name: "worktree_new",
    label: "new worktree",
    description: "Create an isolated git worktree on a new branch for fresh work. Returns the path to run commands in.",
    promptSnippet: "Create a new git worktree",
    parameters: newSchema,
    async execute(_id, params: Static<typeof newSchema>) {
      try {
        const config = getConfig();
        const repoRoot = await getGitRoot(pi, resolveRepo(params.repo));
        const branch = branchWithPrefix(params.name, config);
        const base = params.base ?? `origin/${await getDefaultBranch(pi, repoRoot, config)}`;
        const path = await ensureWorktree(pi, repoRoot, branch, base, config);
        return textResult(`Worktree ready at ${path} on branch ${branch}. Run your work there (cwd ${path}).`, { path, branch });
      } catch (e) {
        return textResult(`worktree_new failed: ${(e as Error).message}`, { ok: false });
      }
    },
  });

  const adoptSchema = Type.Object({
    branch: Type.Optional(Type.String({ description: "Existing branch to check out in its own worktree." })),
    pr: Type.Optional(Type.String({ description: "PR number whose head branch to adopt (uses gh)." })),
    repo: repoParam,
  });
  pi.registerTool({
    name: "worktree_adopt",
    label: "adopt worktree",
    description: "Check out an EXISTING branch (or a PR's branch) in its own worktree — use this for reviewing/continuing work that already has a branch, instead of creating a fresh one.",
    promptSnippet: "Adopt an existing branch into a worktree",
    parameters: adoptSchema,
    async execute(_id, params: Static<typeof adoptSchema>) {
      try {
        const config = getConfig();
        const repoRoot = await getGitRoot(pi, resolveRepo(params.repo));
        let branch = params.branch ? normaliseBranchName(params.branch) : undefined;
        if (!branch && params.pr) branch = (await branchForPullRequest(pi, repoRoot, params.pr)).branch;
        if (!branch) return textResult("Provide either `branch` or `pr`.", { ok: false });
        const path = await ensureAdoptedWorktree(pi, repoRoot, branch, config);
        return textResult(`Adopted ${branch} at ${path}. Work there (cwd ${path}).`, { path, branch });
      } catch (e) {
        return textResult(`worktree_adopt failed: ${(e as Error).message}`, { ok: false });
      }
    },
  });

  const statusSchema = Type.Object({
    path: Type.Optional(Type.String({ description: "Worktree path (default: current directory)." })),
  });
  pi.registerTool({
    name: "worktree_status",
    label: "worktree status",
    description: "Show a worktree's current branch and how many files have changed.",
    promptSnippet: "Show worktree status",
    parameters: statusSchema,
    async execute(_id, params: Static<typeof statusSchema>) {
      try {
        const cwd = params.path ? resolve(expandHome(params.path)) : process.cwd();
        return textResult(await statusLine(pi, cwd), { ok: true });
      } catch (e) {
        return textResult(`worktree_status failed: ${(e as Error).message}`, { ok: false });
      }
    },
  });

  const mergeSchema = Type.Object({
    target: Type.String({ description: "Branch to integrate the work INTO (e.g. main)." }),
    branch: Type.Optional(Type.String({ description: "Source branch to integrate (default: current branch)." })),
    mode: Type.Optional(
      Type.Union([Type.Literal("squash"), Type.Literal("merge"), Type.Literal("cherry-pick")], {
        description: "Integration mode (default: the configured mode).",
      }),
    ),
    repo: repoParam,
  });
  pi.registerTool({
    name: "worktree_merge",
    label: "merge worktree",
    description: "Integrate a worktree's branch into a target branch (squash/merge/cherry-pick). Reports conflicts for you to resolve; does not remove the worktree.",
    promptSnippet: "Integrate a worktree branch into a target",
    parameters: mergeSchema,
    async execute(_id, params: Static<typeof mergeSchema>) {
      try {
        const config = getConfig();
        const repoRoot = await getGitRoot(pi, resolveRepo(params.repo));
        const branch = params.branch ?? (await getCurrentBranch(pi, process.cwd()));
        const mode = params.mode ?? config.defaultIntegrateMode;
        const worktrees = await listWorktrees(pi, repoRoot);
        const src = worktrees.find((w) => w.branch === branch);
        if (src) {
          const dirty = (await pi.exec("git", ["status", "--porcelain"], { cwd: src.path })).stdout.trim();
          if (dirty) return textResult(`Commit or stash changes in ${branch} before merging.`, { ok: false });
        }
        const targetCheckout = worktrees.find((w) => w.branch === params.target)?.path ?? repoRoot;
        const co = await pi.exec("git", ["checkout", params.target], { cwd: targetCheckout });
        if (co.code !== 0) return textResult(`Could not checkout ${params.target}: ${co.stderr.trim()}`, { ok: false });
        const args =
          mode === "squash"
            ? ["merge", "--squash", branch]
            : mode === "merge"
              ? ["merge", "--no-ff", branch]
              : ["cherry-pick", `${params.target}..${branch}`];
        const m = await pi.exec("git", args, { cwd: targetCheckout });
        if (m.code !== 0) {
          return textResult(`Merge (${mode}) of ${branch} into ${params.target} failed — resolve manually:\n${m.stderr.trim() || m.stdout.trim()}`, {
            ok: false,
            conflict: true,
            branch,
            target: params.target,
          });
        }
        const note = mode === "squash" ? " Staged changes are ready to commit." : "";
        return textResult(`Integrated ${branch} into ${params.target} using ${mode}.${note} Remove the worktree with worktree_remove when done.`, {
          ok: true,
          branch,
          target: params.target,
          mode,
        });
      } catch (e) {
        return textResult(`worktree_merge failed: ${(e as Error).message}`, { ok: false });
      }
    },
  });

  const removeSchema = Type.Object({
    branch: Type.Optional(Type.String({ description: "Branch whose worktree to remove." })),
    path: Type.Optional(Type.String({ description: "Worktree path to remove (alternative to branch)." })),
    deleteBranch: Type.Optional(Type.Boolean({ description: "Also delete the local branch (default false)." })),
    repo: repoParam,
  });
  pi.registerTool({
    name: "worktree_remove",
    label: "remove worktree",
    description: "Remove a git worktree (and optionally its local branch) once its work is integrated or abandoned.",
    promptSnippet: "Remove a git worktree",
    parameters: removeSchema,
    async execute(_id, params: Static<typeof removeSchema>) {
      try {
        const config = getConfig();
        const repoRoot = await getGitRoot(pi, resolveRepo(params.repo));
        let target = params.path ? resolve(expandHome(params.path)) : undefined;
        let branch = params.branch;
        if (!target && branch) {
          const wt = await findWorktree(pi, repoRoot, branch, config);
          target = wt?.path;
          branch = wt?.branch ?? branch;
        }
        if (!target) return textResult("Provide a `branch` or `path` to remove.", { ok: false });
        const rm = await pi.exec("git", ["worktree", "remove", "--force", target], { cwd: repoRoot });
        if (rm.code !== 0) return textResult(`Could not remove worktree ${target}: ${rm.stderr.trim()}`, { ok: false });
        if (params.deleteBranch && branch) await pi.exec("git", ["branch", "-D", branch], { cwd: repoRoot });
        return textResult(`Removed worktree ${target}${params.deleteBranch && branch ? ` and branch ${branch}` : ""}.`, { ok: true });
      } catch (e) {
        return textResult(`worktree_remove failed: ${(e as Error).message}`, { ok: false });
      }
    },
  });
}
