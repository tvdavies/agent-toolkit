/**
 * `brain correct <slug>` — open the file in $EDITOR.
 *
 * Manual edits should feel native: vim / nvim / code / nano on the
 * raw markdown, then save. The `brain watch` daemon (or a follow-up
 * `brain reindex`) reconciles the index. The edit also bumps
 * authority — explicit user changes are stronger signal than
 * extracted output.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parse, serialise } from "@ai-assistant/memory";
import type { ParsedArgs } from "../shared/args.js";
import { flag } from "../shared/args.js";
import { resolveBrainPath, resolveScope } from "../shared/brain.js";
import { resolveSlugPath } from "./get.js";

export async function runCorrect(args: ParsedArgs): Promise<void> {
  const slug = args.positional[0];
  if (slug === undefined || slug === "") {
    process.stderr.write("Usage: brain correct <slug>\n");
    process.exit(2);
  }
  const rootDir = resolveBrainPath(flag(args, "root"));
  const scope = resolveScope(flag(args, "scope"));
  const filePath = resolveSlugPath(rootDir, scope, slug);
  if (filePath === undefined) {
    process.stderr.write(`No memory matches "${slug}"\n`);
    process.exit(1);
  }

  // Promote authority to 'manual' before opening — even if the user
  // changes nothing, having opened the file in $EDITOR is a strong
  // signal. (They'd have used `brain pin` for stronger.)
  const beforeText = readFileSync(filePath, "utf8");
  const { frontmatter, body } = parse(beforeText);
  if (frontmatter.authority !== "pinned" && frontmatter.authority !== "manual") {
    writeFileSync(filePath, serialise({ ...frontmatter, authority: "manual" }, body));
  }

  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vim";
  const child = spawn(editor, [filePath], { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${editor} exited with code ${code}`));
    });
  });
  process.stdout.write(
    `edited ${slug}\n  hint: brain reindex (or run brain watch in another tab) to update the index\n`,
  );
}
