import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../daemon/test-helpers/service-audit-mocks.js";
import { applyCliProfileEnv } from "../cli/profile.js";
import { runDoctorLintCli } from "../commands/doctor-lint.js";
import { renderTriagePrompt } from "../commands/triage-prompt.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import {
  execSystemctlUserMock,
  resetServiceAuditMocks,
  resolveNodeRuntimeInfoMock,
} from "../daemon/test-helpers/service-audit-fixtures.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

function detect(
  cfg: Parameters<NonNullable<(typeof CORE_HEALTH_CHECKS)[number]["detect"]>>[0]["cfg"] = {},
) {
  const check = CORE_HEALTH_CHECKS.find(
    (entry) => entry.id === "core/doctor/gateway-services/platform-notes",
  );
  if (!check) {
    throw new Error("Missing registered gateway platform notes check");
  }
  return check.detect({ mode: "lint", runtime, cfg });
}

const checkId = "core/doctor/gateway-services/platform-notes";
const legacyUnit = "[Service]\nKillMode=control-group\n";
const killModeWarning = {
  severity: "warning",
  message: expect.stringContaining("KillMode=mixed"),
};

function expectText(text: string, ...parts: string[]) {
  for (const part of parts) {
    expect(text).toContain(part);
  }
}

function triage(
  findings: Parameters<typeof renderTriagePrompt>[0]["findings"],
  stateDir = ".openclaw",
) {
  return renderTriagePrompt({
    findings,
    bundle: { kind: "skipped" },
    redaction: { env: process.env, stateDir: path.join(home, stateDir) },
  });
}

function effectiveUnit(mode: string, loadState: string) {
  execSystemctlUserMock.mockResolvedValue({
    stdout: `KillMode=${mode}\nLoadState=${loadState}\n`,
    stderr: "",
    code: 0,
    termination: "exit",
  });
}

const runtime = { log() {}, error() {}, exit() {} };
let home: string;
let unitPath: string;

beforeEach(async () => {
  resetServiceAuditMocks();
  const account = os.userInfo();
  home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-platform-"));
  vi.spyOn(os, "userInfo").mockReturnValue({ ...account, homedir: home });
  mockProcessPlatform("linux");
  for (const name of [
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_PROFILE",
    "OPENCLAW_SYSTEMD_UNIT",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("HOME", home);
  unitPath = path.join(home, ".config", "systemd", "user", "openclaw-gateway.service");
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe("registered gateway platform notes", () => {
  it("carries legacy systemd shutdown diagnosis and repair advice into triage without changing the unit", async () => {
    const unit =
      "[Unit]\nAfter=network-online.target\nWants=network-online.target\n[Service]\nExecStart=/usr/bin/node gateway\nRestartSec=5\nKillMode=control-group\n";
    await fs.writeFile(unitPath, unit);
    expect(isDefaultInstallIdentity()).toBe(true);

    const findings = await detect({ gateway: { mode: "local" } });
    expect(findings).toEqual([
      expect.objectContaining({
        ...killModeWarning,
        fixHint: expect.stringContaining("gateway install --force"),
      }),
    ]);
    const prompt = triage(findings);
    expectText(prompt, "KillMode=mixed", "gateway install --force", "drop-ins");
    expect(prompt).not.toContain(home);
    expect(await fs.readFile(unitPath, "utf8")).toBe(unit);
  });
  it.each([
    { name: "repaired effective setting", mode: "mixed", loadState: "loaded" },
    { name: "masked service", mode: "control-group", loadState: "masked" },
  ])("does not propose repairs for $name", async ({ mode, loadState }) => {
    await fs.writeFile(unitPath, legacyUnit);
    effectiveUnit(mode, loadState);

    expect(await detect()).toEqual([]);
    expect(resolveNodeRuntimeInfoMock).not.toHaveBeenCalled();
  });

  it("reports an incompatible effective drop-in and preserves the selected profile in triage advice", async () => {
    const profileEnv = { ...process.env };
    applyCliProfileEnv({ profile: "upgrade-proof", env: profileEnv, homedir: () => home });
    for (const name of ["OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]) {
      vi.stubEnv(name, profileEnv[name]);
    }
    const profileUnitPath = path.join(
      path.dirname(unitPath),
      "openclaw-gateway-upgrade-proof.service",
    );
    const unit = "[Service]\nKillMode=mixed\n";
    await fs.writeFile(profileUnitPath, unit);
    effectiveUnit("control-group", "loaded");
    expect(isDefaultInstallIdentity()).toBe(true);

    const findings = await detect();
    const prompt = triage(findings, ".openclaw-upgrade-proof");
    expectText(
      prompt,
      "openclaw --profile upgrade-proof gateway install --force",
      "drop-ins separately",
    );
    expect(execSystemctlUserMock.mock.calls[0]?.[1]).toContain(
      "openclaw-gateway-upgrade-proof.service",
    );
    expect(await fs.readFile(profileUnitPath, "utf8")).toBe(unit);
    expect(resolveNodeRuntimeInfoMock).not.toHaveBeenCalled();
  });

  it.each(["remote", "nix", "relocated"] as const)(
    "does not inspect host service settings for a %s installation",
    async (scope) => {
      await fs.writeFile(unitPath, legacyUnit);
      if (scope === "nix") {
        vi.stubEnv("OPENCLAW_NIX_MODE", "1");
      }
      if (scope === "relocated") {
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "other-state"));
      }

      expect(await detect({ gateway: { mode: scope === "remote" ? "remote" : "local" } })).toEqual(
        [],
      );
      expect(execSystemctlUserMock).not.toHaveBeenCalled();
    },
  );
  it("reports the unit through Doctor JSON while keeping warnings nonblocking at the updater error threshold", async () => {
    await fs.writeFile(unitPath, legacyUnit);
    const stateDir = path.join(home, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
    );
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const lint = (severityMin?: "error") =>
      runDoctorLintCli(runtime, { json: true, onlyIds: [checkId], severityMin });
    expect(await lint()).toBe(1);
    expect(JSON.parse(output).findings).toEqual([expect.objectContaining(killModeWarning)]);
    output = "";
    expect(await lint("error")).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: true });
  });
});
