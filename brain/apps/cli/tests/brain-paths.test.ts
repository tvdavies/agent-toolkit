import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authDir,
  configPath,
  logsDir,
  resolveBrainHome,
  resolveBrainPath,
  resolveScope,
} from "../src/shared/paths.ts";

describe("brain path resolver", () => {
  const original = {
    BRAIN_HOME: process.env.BRAIN_HOME,
    BRAIN_ROOT: process.env.BRAIN_ROOT,
    BRAIN_SCOPE: process.env.BRAIN_SCOPE,
  };

  beforeEach(() => {
    delete process.env.BRAIN_HOME;
    delete process.env.BRAIN_ROOT;
    delete process.env.BRAIN_SCOPE;
  });

  afterEach(() => {
    if (original.BRAIN_HOME !== undefined) process.env.BRAIN_HOME = original.BRAIN_HOME;
    else delete process.env.BRAIN_HOME;
    if (original.BRAIN_ROOT !== undefined) process.env.BRAIN_ROOT = original.BRAIN_ROOT;
    else delete process.env.BRAIN_ROOT;
    if (original.BRAIN_SCOPE !== undefined) process.env.BRAIN_SCOPE = original.BRAIN_SCOPE;
    else delete process.env.BRAIN_SCOPE;
  });

  it("defaults home to ~/brain and root to ~/brain/memories", () => {
    expect(resolveBrainHome()).toBe(resolve(homedir(), "brain"));
    expect(resolveBrainPath()).toBe(resolve(homedir(), "brain", "memories"));
  });

  it("BRAIN_HOME env shifts both home and root", () => {
    process.env.BRAIN_HOME = "/tmp/custom-brain";
    expect(resolveBrainHome()).toBe("/tmp/custom-brain");
    expect(resolveBrainPath()).toBe("/tmp/custom-brain/memories");
  });

  it("BRAIN_ROOT env decouples root from home", () => {
    process.env.BRAIN_ROOT = "/tmp/wiki";
    expect(resolveBrainHome()).toBe(resolve(homedir(), "brain"));
    expect(resolveBrainPath()).toBe("/tmp/wiki");
  });

  it("CLI flags win over env vars", () => {
    process.env.BRAIN_HOME = "/tmp/env-home";
    process.env.BRAIN_ROOT = "/tmp/env-root";
    expect(resolveBrainHome("/tmp/flag-home")).toBe("/tmp/flag-home");
    expect(resolveBrainPath("/tmp/flag-root")).toBe("/tmp/flag-root");
  });

  it("relative paths resolve against cwd", () => {
    expect(resolveBrainHome("relative")).toBe(resolve(process.cwd(), "relative"));
    expect(resolveBrainPath("relative-root")).toBe(resolve(process.cwd(), "relative-root"));
  });

  it("scope resolution: flag > env > default", () => {
    expect(resolveScope()).toBe("personal");
    process.env.BRAIN_SCOPE = "work";
    expect(resolveScope()).toBe("work");
    expect(resolveScope("override")).toBe("override");
  });

  it("home-derived helpers", () => {
    const home = "/tmp/brain";
    expect(authDir(home)).toBe("/tmp/brain/auth");
    expect(logsDir(home)).toBe("/tmp/brain/logs");
    expect(configPath(home)).toBe("/tmp/brain/config.yaml");
  });
});
