import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const skill = path.join(root, "skills/lleverage/guided-runbook");
const lib = path.join(skill, "scripts/lib/wizard.sh");

function withTmp(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "guided-runbook-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Runs a script body after sourcing the library, with stub tools on PATH.
function runWizard(dir: string, body: string, answers = "") {
  const tty = path.join(dir, "tty");
  writeFileSync(tty, answers);
  const script = path.join(dir, "runbook.sh");
  writeFileSync(script, `. "${lib}"\nwiz_init "Test" 2\n${body}\n`);
  return spawnSync("bash", [script], {
    env: { PATH: `${dir}/bin:${process.env.PATH}`, HOME: dir, WIZ_TTY: tty, WIZ_LOG_DIR: dir, OP_AGENT_ENV: path.join(dir, "agent.env") },
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("guided-runbook", () => {
  test("No stops the run cleanly before the change; y lets it through", () => {
    withTmp((dir) => {
      const body = `step "Change"\nconfirm_or_stop "Do it?"\necho CHANGED`;
      const no = runWizard(dir, body, "n\n");
      expect(no.status).toBe(0);
      expect(no.stdout).not.toContain("CHANGED");
      expect(no.stdout).toContain("Run the same command again");
      const yes = runWizard(dir, body, "y\n");
      expect(yes.stdout).toContain("CHANGED");
    });
  });

  test("dry run answers No even when the terminal would say yes", () => {
    withTmp((dir) => {
      const tty = path.join(dir, "tty");
      writeFileSync(tty, "y\n");
      const res = spawnSync("bash", ["-c", `. "${lib}"; wiz_init T 1; if ask "x?"; then echo YES; else echo NO; fi`], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: dir, WIZ_LOG_DIR: dir, WIZ_TTY: tty, WIZ_DRY_RUN: "1" },
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("NO");
      expect(res.stdout).not.toContain("YES");
    });
  });

  test("read-modify-write guards refuse empty reads and removals", () => {
    withTmp((dir) => {
      const empty = runWizard(dir, `: >"$WIZ_TMP/a"\nguard_nonempty "$WIZ_TMP/a" "The policy read"\necho WROTE`);
      expect(empty.status).not.toBe(0);
      expect(empty.stdout).not.toContain("WROTE");

      const removal = runWizard(dir, `printf 'a\\nb\\n' >"$WIZ_TMP/a"; printf 'a\\nc\\n' >"$WIZ_TMP/b"\nguard_additive "$WIZ_TMP/a" "$WIZ_TMP/b"\necho WROTE`);
      expect(removal.status).not.toBe(0);
      expect(removal.stdout).toContain("remove 1 existing lines");

      const additive = runWizard(dir, `printf 'a\\n' >"$WIZ_TMP/a"; printf 'a\\nb\\n' >"$WIZ_TMP/b"\nguard_additive "$WIZ_TMP/a" "$WIZ_TMP/b" && echo CHANGE\ncp "$WIZ_TMP/a" "$WIZ_TMP/c"; guard_additive "$WIZ_TMP/a" "$WIZ_TMP/c" || echo NOTHING`);
      expect(additive.stdout).toContain("CHANGE");
      expect(additive.stdout).toContain("NOTHING");

      const raced = runWizard(dir, `printf 'a\\n' >"$WIZ_TMP/a"; printf 'a\\nz\\n' >"$WIZ_TMP/b"\nguard_unchanged "$WIZ_TMP/a" "$WIZ_TMP/b" "The policy"\necho WROTE`);
      expect(raced.status).not.toBe(0);
      expect(raced.stdout).toContain("changed while waiting");
      expect(raced.stdout).not.toContain("WROTE");
    });
  });

  test("secrets land in a variable, never in output, and the 1Password token stays in its subshell", () => {
    withTmp((dir) => {
      const bin = path.join(dir, "bin");
      spawnSync("mkdir", [bin]);
      writeFileSync(path.join(bin, "op"), `#!/usr/bin/env bash\n[[ -n "$OP_SERVICE_ACCOUNT_TOKEN" ]] || exit 9\necho '{"root_token":"s.supersecret"}'\n`);
      chmodSync(path.join(bin, "op"), 0o755);
      writeFileSync(path.join(dir, "agent.env"), "export OP_SERVICE_ACCOUNT_TOKEN=ops_test\n");
      const res = runWizard(dir, `openbao_root_token TOK staging\n[[ "$TOK" == s.supersecret ]] && echo MATCH\n[[ -z "\${OP_SERVICE_ACCOUNT_TOKEN:-}" ]] && echo CLEAN`);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("MATCH");
      expect(res.stdout).toContain("CLEAN");
      expect(res.stdout + res.stderr).not.toContain("supersecret");

      // A wrong jq path on a secret document must not echo the value in jq's error.
      const wrongPath = runWizard(dir, `op_document_field X item vault '.root_token[]'`);
      expect(wrongPath.status).not.toBe(0);
      expect(wrongPath.stdout + wrongPath.stderr).not.toContain("supersecret");

      const traced = runWizard(dir, `set -x\nopenbao_root_token TOK staging`);
      expect(traced.status).not.toBe(0);
      expect(traced.stdout + traced.stderr).not.toContain("ops_test");
      expect(traced.stdout + traced.stderr).toContain("xtrace is on");
    });
  });

  // The Sal office serves runbooks after helpers whose EXIT and INT traps report how the run ended.
  test("wiz_init keeps the EXIT and signal traps set before it", () => {
    withTmp((dir) => {
      const run = (body: string) => {
        const script = path.join(dir, "runbook.sh");
        const report = path.join(dir, "report");
        writeFileSync(report, "");
        writeFileSync(
          script,
          `trap 'echo "exit=$? sig=\${SIG:-}" >>"${report}"' EXIT\ntrap 'SIG=INT; exit 130' INT\ntrap 'SIG=TERM; exit 143' TERM\n. "${lib}"\nwiz_init "Test" 1\n${body}\n`,
        );
        const res = spawnSync("bash", [script], { env: { PATH: process.env.PATH, HOME: dir, WIZ_LOG_DIR: dir }, encoding: "utf8", timeout: 20_000 });
        return { status: res.status, report: readFileSync(report, "utf8").trim(), tmpLeft: res.stdout.includes("TMP=") && existsSync(res.stdout.match(/TMP=(\S+)/)![1]!) };
      };
      expect(run(`echo TMP=$WIZ_TMP`)).toEqual({ status: 0, report: "exit=0 sig=", tmpLeft: false });
      expect(run(`echo TMP=$WIZ_TMP\nfalse`)).toEqual({ status: 1, report: "exit=1 sig=", tmpLeft: false });
      expect(run(`echo TMP=$WIZ_TMP\nkill -INT $$\nsleep 5`)).toEqual({ status: 130, report: "exit=130 sig=INT", tmpLeft: false });
      expect(run(`echo TMP=$WIZ_TMP\nkill -TERM $$\nsleep 5`)).toEqual({ status: 143, report: "exit=143 sig=TERM", tmpLeft: false });
    });
  });

  // Served by the Sal office, rb-lib.sh defines rb_step and rb_skip; wiz_step reports each step through them.
  test("wiz_step reports its step to the office's rb_step, and a skip in it to rb_skip once", () => {
    withTmp((dir) => {
      const reports = path.join(dir, "reports");
      const office = `rb_step() { echo "step $1|$2" >>"${reports}"; echo "==> $2"; }\nrb_skip() { echo "skip $1" >>"${reports}"; echo "already done: $1"; }\n`;
      const body = `wiz_step check "Check access"\nskip "access is there"\nskip "and so is the role"\nwiz_step apply "Apply"\ninfo "part of it is done"\necho APPLIED\nstep "Unreported"\nskip "not a wiz_step step"\nwiz_done`;
      writeFileSync(path.join(dir, "runbook.sh"), `${office}. "${lib}"\nwiz_init "Test" 3\n${body}\n`);
      const res = spawnSync("bash", [path.join(dir, "runbook.sh")], { env: { PATH: process.env.PATH, HOME: dir, WIZ_LOG_DIR: dir }, encoding: "utf8", timeout: 20_000 });
      expect(res.status).toBe(0);
      expect(readFileSync(reports, "utf8")).toBe("step check|Check access\nskip access is there\nstep apply|Apply\n");
      expect(res.stdout).toContain("Step 1/3: Check access");
      expect(res.stdout).toContain("Step 3/3: Unreported");
      expect(res.stdout).toContain("APPLIED");
      // The office helpers' own lines are left to the wizard's.
      expect(res.stdout).not.toContain("==> ");
      expect(res.stdout).not.toContain("already done:");
    });
  });

  test("wiz_step without the office is a plain step; a bad ID stops the run", () => {
    withTmp((dir) => {
      const plain = runWizard(dir, `wiz_step check "Check access"\nskip "done already"\necho AFTER`);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain("Step 1/2: Check access");
      expect(plain.stdout).toContain("SKIP");
      expect(plain.stdout).toContain("AFTER");
      const bad = runWizard(dir, `wiz_step "two words" "Title"\necho AFTER`);
      expect(bad.status).not.toBe(0);
      expect(bad.stdout + bad.stderr).toContain("isn't a step ID");
      expect(bad.stdout).not.toContain("AFTER");
    });
  });

  test("the checker passes the template and rejects the patterns that caused friction", () => {
    const template = spawnSync("bash", [path.join(skill, "scripts/check-runbook.sh"), path.join(skill, "templates/runbook.sh")], { encoding: "utf8" });
    expect(template.stdout).toContain("check-runbook: passed");

    withTmp((dir) => {
      const bad = path.join(dir, "bad.sh");
      writeFileSync(bad, `#!/usr/bin/env bash\n. "$HOME/.agents/skills/guided-runbook/scripts/lib/wizard.sh"\nwiz_init "x" 1\nTOKEN="$(jq -r .root_token "$INFRA/generated/staging/openbao-init.json")"\nread -r -p "Continue? " a\nset -o errexit -o xtrace\n`);
      const res = spawnSync("bash", [path.join(skill, "scripts/check-runbook.sh"), bad], { encoding: "utf8" });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("FAIL no local OpenBao init files");
      expect(res.stdout).toContain("FAIL no bare read prompts");
      expect(res.stdout).toContain("FAIL no xtrace");
    });
  });
});
