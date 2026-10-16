import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createPublisherRepoFactory, runPublisher } from "./pr-prepare.test-support.js";
import { validReview } from "./pr-review-artifact-fixture.js";

const templates = useAutoCleanupTempDirTracker(afterAll);
const makePublisherRepo = createPublisherRepoFactory({
  cases: useAutoCleanupTempDirTracker(afterEach),
  templates,
});
const describePosix = process.platform === "win32" ? describe.skip : describe;
let signingKey: string;
let allowedSigners: string;

function fixture(transport: "auto" | "graphql" = "graphql") {
  const f = makePublisherRepo();
  // Metadata is native fixture state, never part of the reviewed candidate.
  appendFileSync(join(f.repoDir, ".git/info/exclude"), "\n.local/\n");
  f.env.OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH = "";
  f.env.OPENCLAW_PR_PUSH_MODE = transport;
  if (transport === "auto") {
    f.git("config", "gpg.format", "ssh");
    f.git("config", "user.signingKey", signingKey);
    f.git("config", "gpg.ssh.allowedSignersFile", allowedSigners);
    f.git("commit", "--amend", "-S", "--no-edit");
    f.candidate = f.git("rev-parse", "HEAD");
    f.git("verify-commit", f.candidate);
  }
  const metadata = { ...f.observation, baseRefOid: f.base, files: [{ path: "reviewed.txt" }] };
  writeFileSync(join(f.local, "pr-meta.json"), JSON.stringify(metadata));
  writeFileSync(join(f.local, "remote-observation.json"), JSON.stringify(metadata));
  const incoming = validReview(f.source);
  incoming.pr.number = 4242;
  incoming.issueValidation.status = "valid";
  incoming.findings.push({
    id: "I1",
    severity: "IMPORTANT",
    title: "Incorrect publication behavior",
    area: "reviewed.txt",
    fix: "Preserve publication authority",
  });
  const incomingBytes = JSON.stringify(incoming);
  writeFileSync(join(f.local, "review.json"), incomingBytes);
  writeFileSync(join(f.local, "correction-incoming-review.json"), incomingBytes);
  const incomingOid = f.git("hash-object", "--no-filters", ".local/review.json");
  appendFileSync(
    join(f.local, "prep-context.env"),
    `PREP_REVIEW_MODE=correction\nPREP_INCOMING_JSON_OID=${incomingOid}\n`,
  );
  const reviewed = validReview(f.candidate);
  reviewed.pr.number = 4242;
  reviewed.recommendation = "READY FOR /prepare-pr";
  reviewed.issueValidation.status = "valid";
  writeFileSync(
    join(f.local, "correction-review.json"),
    JSON.stringify({
      ...reviewed,
      correction: {
        incomingHeadSha: f.source,
        incomingReviewJsonOid: incomingOid,
        resolvedFindings: [{ id: "I1", resolution: "The publication fix is reviewed." }],
      },
    }),
  );
  writeFileSync(
    join(f.local, "gates.env"),
    `PR_NUMBER=4242\nGATES_MODE=remote_crabbox_aws_pending\nLAST_VERIFIED_HEAD_SHA=${f.candidate}\nREMOTE_GATES_PROVIDER=aws\n`,
  );
  return {
    ...f,
    read: (name: string) => readFileSync(join(f.local, name), "utf8"),
    write: (name: string, value: string | Buffer) => writeFileSync(join(f.local, name), value),
    has: (name: string) => existsSync(join(f.local, name)),
    hosted: () => f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic"),
  };
}

function runCorrection(
  f: ReturnType<typeof fixture>,
  options: { command?: string; setup?: string[]; duringProof?: string } = {},
) {
  return runPublisher(f, options.command ?? "prepare_push 4242", [
    // Preserve the fixture transport before review.sh reloads the GitHub helpers.
    "eval \"$(declare -f pr_gh_plain | sed '1s/pr_gh_plain/fixture_gh_plain/')\"",
    // Restore the actual correction owner instead of the generic publisher fixture's stub.
    'source "$script_parent_dir/pr-lib/review.sh"',
    'pr_gh_run() { echo "unexpected external GitHub request" >&2; return 98; }',
    "PR_HEAD_OWNER=fixture",
    "PR_HEAD_REPO_NAME=repo",
    "pr_gh() {",
    '  echo "$*" >> .local/github-reads',
    '  case "$*" in',
    '    "pr view "*) jq -c --arg sha "$(remote_head)" ".headRefOid = \\$sha" .local/remote-observation.json;;',
    '    *) echo "unexpected GitHub request" >&2; return 98;;',
    "  esac",
    "}",
    // Keep transport publication real against the bare fixture remote; only GitHub is synthetic.
    "pr_gh_writer_login() { echo fixture; }",
    "pr_gh_plain() {",
    '  if [ "$1" = api ] && [ "$2" = orgs/openclaw/memberships/fixture ]; then',
    '    printf \'{"state":"active","role":"admin"}\\n\'',
    '  else fixture_gh_plain "$@"; fi',
    "}",
    // The protected publisher is the external process boundary. The real finalizer
    // must validate its exact tuple and revalidate correction custody afterward.
    "run_quiet_logged() {",
    '  [ "$3" = node ] && [ "$4" = "$script_parent_dir/pr-lib/ci-dispatch.mjs" ] || return 97',
    "  echo proof >> .local/events",
    options.duringProof ?? ":",
    '  jq -nc --arg head "$7" --arg base "$8" \'{backend:"crabbox",provider:"aws",target:"linux",headSha:$head,baseSha:$base,workflowSha:$base,runId:"run_fixture",leaseId:"cbx_fixture",actionsRunUrl:"https://github.com/openclaw/openclaw/actions/runs/1",actionsRunAttempt:1}\' > "$2"',
    "}",
    ...(options.setup ?? []),
  ]);
}

function expectIncomplete(f: ReturnType<typeof fixture>) {
  expect(f.has("prep.env")).toBe(false);
  expect(f.read("gates.env")).toContain("GATES_MODE=remote_crabbox_aws_pending\n");
  expect(f.read("prep.md")).not.toContain("Gates passed");
}

describePosix("correction publication authority handoff", () => {
  beforeAll(() => {
    const root = templates.make("openclaw-correction-signing-");
    signingKey = join(root, "key");
    allowedSigners = join(root, "allowed-signers");
    const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", signingKey]);
    expect(generated.status, generated.stderr.toString()).toBe(0);
    writeFileSync(
      allowedSigners,
      `fixture@example.invalid ${readFileSync(`${signingKey}.pub`, "utf8")}`,
    );
  });

  it.each(["auto", "graphql"] as const)(
    "completes the first %s publication through protected-gate finalization",
    (transport) => {
      const f = fixture(transport);
      const before = f.read("review.json");
      const result = runCorrection(f);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const hosted = f.hosted();
      expect(hosted === f.candidate).toBe(transport === "auto");
      expect(f.git("rev-parse", `${hosted}^{tree}`)).toBe(f.git("rev-parse", "HEAD^{tree}"));
      expect(f.read("events")).toBe(`${transport === "auto" ? "push" : "graphql"}\nproof\n`);
      expect(f.read("prepare-push-result.env")).toContain(`PUSHED_FROM_SHA=${f.source}\n`);
      expect(f.read("prep.env")).toContain(`PREP_HEAD_SHA=${hosted}\n`);
      expect(f.read("prep.env")).toContain(`LOCAL_PREP_HEAD_SHA=${f.candidate}\n`);
      expect(f.read("gates.env")).toContain(
        `GATES_MODE=remote_crabbox_aws\nHOSTED_GATES_TARGET_HEAD_SHA=''\nLAST_VERIFIED_HEAD_SHA=${hosted}\nFULL_GATES_HEAD_SHA=${hosted}\n`,
      );
      expect(f.read("review.json")).toBe(before);
    },
  );

  it.each([
    ["auto", "prepare_push"],
    ["graphql", "prepare_push"],
    ["graphql", "prepare_sync_head"],
  ] as const)(
    "publishes and resumes a reviewed %s correction through %s with pending GitHub gates",
    (transport, command) => {
      const f = fixture(transport);
      const incomingReview = f.read("review.json");
      f.write(
        "gates.env",
        `PR_NUMBER=4242\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.candidate}\n`,
      );
      const published = runCorrection(f, { command: `${command} 4242` });
      expect(published.status, published.stdout + published.stderr).toBe(0);
      const hosted = f.hosted();
      const gates = f.read("gates.env");
      expect(gates).toContain(`HOSTED_GATES_TARGET_HEAD_SHA=${hosted}\n`);
      expect(gates).not.toMatch(/GATES_PASSED_AT|LAST_VERIFIED_HEAD_SHA|FULL_GATES_HEAD_SHA/);
      expect(f.read("prep.env")).toContain(`LOCAL_PREP_HEAD_SHA=${f.candidate}\n`);
      expect(f.read("prep.md")).not.toContain("Gates passed");
      const resumed = runCorrection(f);
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
      expect(f.read("gates.env")).toBe(gates);
      expect(f.read("events")).toBe(`${transport === "auto" ? "push" : "graphql"}\n`);
      expect(f.read("review.json")).toBe(incomingReview);
    },
  );

  it.each(["missing", "stale", "foreign-pr", "changed-review"])(
    "refuses pending correction publication with %s binding",
    (fault) => {
      const f = fixture();
      f.write(
        "gates.env",
        `PR_NUMBER=${fault === "foreign-pr" ? 42 : 4242}\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${fault === "missing" ? "" : fault === "stale" ? f.source : f.candidate}\n`,
      );
      if (fault === "changed-review") {
        const path = join(f.local, "correction-review.json");
        const review = JSON.parse(readFileSync(path, "utf8"));
        review.pr.headSha = f.source;
        writeFileSync(path, JSON.stringify(review));
      }
      const result = runCorrection(f);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.read("events")).toBe("");
      expect(f.hosted()).toBe(f.source);
      expect(f.has("prep.env")).toBe(false);
    },
  );

  it.each(["failed", "malformed"])(
    "does not select either transport after %s publication-baseline validation",
    (fault) => {
      const f = fixture("auto");
      const result = runCorrection(f, {
        setup: [
          "eval \"$(declare -f run_prepared_correction_review | sed '1s/run_prepared_correction_review/fixture_correction_review/')\"",
          "run_prepared_correction_review() {",
          '  if [ "$2" = publication-baseline ]; then',
          fault === "failed" ? "    return 1" : "    printf 'not-a-commit'; return 0",
          "  fi",
          '  fixture_correction_review "$@"',
          "}",
        ],
      });
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.read("events")).toBe("");
      expect(f.hosted()).toBe(f.source);
      expect(f.has("prepare-push-result.env")).toBe(false);
    },
  );

  it("publishes a signed baseline refresh only after fresh exact-candidate review and gates", () => {
    const f = fixture("auto");
    f.git("branch", "-m", "pr-4242-prep");
    const contextPath = join(f.local, "prep-context.env");
    writeFileSync(
      contextPath,
      readFileSync(contextPath, "utf8").replace("PREP_BRANCH=prep", "PREP_BRANCH=pr-4242-prep"),
    );
    const oldGates = readFileSync(join(f.local, "gates.env"));
    f.git("checkout", "-q", "-b", "baseline", f.base);
    writeFileSync(join(f.repoDir, "upstream.txt"), "upstream baseline repair\n");
    f.git("add", "upstream.txt");
    f.git("commit", "-qm", "fix: upstream baseline");
    const baseline = f.git("rev-parse", "HEAD");
    f.git("checkout", "-q", "pr-4242-prep");
    const refreshed = runCorrection(f, {
      command: `prepare_baseline_refresh 4242 --expected-head ${f.candidate} --baseline ${baseline}`,
      setup: [
        'source "$script_parent_dir/pr-lib/operation-lock.sh"',
        "mark_pr_operation_side_effects_started() { :; }",
        `enter_worktree() { PR_MAIN_SHA=${baseline}; }`,
        "PR_OPERATION_LOCK_REF=refs/openclaw/pr-operation-locks/4242",
        `PR_OPERATION_LOCK_OWNER_OID=${f.source}`,
        'git update-ref "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID"',
      ],
    });
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    const head = f.git("rev-parse", "HEAD");
    const initialized = runCorrection(f, { command: "prepare_correction_review_init 4242" });
    expect(initialized.status, initialized.stdout + initialized.stderr).toBe(0);
    const reviewPath = join(f.local, "correction-review.json");
    const review = JSON.parse(readFileSync(reviewPath, "utf8"));
    Object.assign(review, validReview(head));
    review.pr.number = 4242;
    review.recommendation = "READY FOR /prepare-pr";
    review.issueValidation.status = "valid";
    review.correction.resolvedFindings[0].resolution = "Reviewed the full refreshed product delta.";
    writeFileSync(reviewPath, JSON.stringify(review));
    f.write("gates.env", oldGates);
    const stale = runCorrection(f);
    expect(stale.status).not.toBe(0);
    expect(f.hosted()).toBe(f.source);
    expect(f.read("events")).not.toContain("push");
    f.write(
      "gates.env",
      `PR_NUMBER=4242\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${head}\nFULL_GATES_HEAD_SHA=${head}\n`,
    );
    const published = runCorrection(f);
    expect(published.status, published.stdout + published.stderr).toBe(0);
    expect(f.hosted()).toBe(head);
    expect(f.git("show", "-s", "--format=%P", head)).toBe(`${f.candidate} ${baseline}`);
    f.git("verify-commit", head);
    expect(f.read("events")).toBe("push\n");
    expect(f.read("prepare-push-result.env")).toContain(`PUSH_LOCAL_PREP_HEAD_SHA=${head}\n`);
  });

  it.each(["review", "other receipt", "selected receipt", "removed receipt"])(
    "rejects %s mutation while protected proof is running",
    (changed) => {
      const f = fixture();
      if (changed === "removed receipt") {
        f.write(
          "prepare-sync-result.env",
          `PUSH_PREP_HEAD_SHA=${f.source}\nPUSH_LOCAL_PREP_HEAD_SHA=${f.source}\nPUSHED_FROM_SHA=${f.source}\nPUSH_REPLACED_HOSTED_ANCESTRY=false\nPR_HEAD_SHA_AFTER_PUSH=${f.source}\n`,
        );
      }
      const path =
        changed === "review"
          ? ".local/correction-review.json"
          : changed === "other receipt"
            ? ".local/prepare-sync-result.env"
            : ".local/prepare-push-result.env";
      const result = runCorrection(f, {
        duringProof:
          changed === "removed receipt"
            ? "rm .local/prepare-sync-result.env"
            : changed === "other receipt"
              ? `cp .local/prepare-push-result.env ${path}`
              : changed === "selected receipt"
                ? `LC_ALL=C sort -o "${path}" "${path}"`
                : `printf '\\n' >> ${path}`,
      });
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr).toContain("Correction review authority changed");
      expect(f.read("events")).toBe("graphql\nproof\n");
      expectIncomplete(f);
    },
  );

  it("admits the named sync receipt with completed correction gates", () => {
    const f = fixture();
    f.write(
      "gates.env",
      `PR_NUMBER=4242\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${f.candidate}\nFULL_GATES_HEAD_SHA=${f.candidate}\n`,
    );
    const result = runCorrection(f, { command: "prepare_sync_head 4242" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const hosted = f.hosted();
    expect(f.read("prepare-sync-result.env")).toContain(`PUSH_PREP_HEAD_SHA=${hosted}\n`);
    expect(f.read("prep.env")).toContain(`PREP_HEAD_SHA=${hosted}\n`);
    expect(f.read("events")).toBe("graphql\n");
  });

  it.each(["writer failure", "replaced result"])(
    "does not advance authority or start proof after %s",
    (fault) => {
      const f = fixture();
      const result = runCorrection(f, {
        setup: [
          "eval \"$(declare -f pr_git | sed '1s/pr_git/fixture_git/')\"",
          "pr_git() {",
          fault === "writer failure"
            ? '  if [ "$*" = "hash-object --stdin" ]; then mkdir .local/prepare-push-result.env; fi'
            : '  if [ "$*" = "hash-object --no-filters -- .local/prepare-push-result.env" ]; then printf "\\n" >> .local/prepare-push-result.env; fi',
          '  fixture_git "$@"',
          "}",
        ],
        command: [
          "if prepare_push 4242; then exit 99; else status=$?; fi",
          `test "$PREP_PUBLICATION_LEASE_SHA" = '${f.source}' || exit 98`,
          'exit "$status"',
        ].join("\n"),
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(
        fault === "writer failure" ? "Is a directory" : "Correction review authority changed",
      );
      expect(f.read("events")).toBe("graphql\n");
      expectIncomplete(f);
    },
  );

  it("preserves an exact no-op receipt and advances stale process-local authority", () => {
    const f = fixture();
    const published = runCorrection(f);
    expect(published.status, published.stdout + published.stderr).toBe(0);
    const hosted = f.hosted();
    const resultPath = join(f.local, "prepare-push-result.env");
    const receipt = readFileSync(resultPath, "utf8");
    const result = runCorrection(f, {
      command: [
        "source .local/prep-context.env",
        "PREP_PUBLICATION_PR=4242",
        "PREP_PUBLICATION_REVIEW_SNAPSHOT=$(correction_review_snapshot 4242)",
        `PREP_PUBLICATION_LEASE_SHA='${f.source}'`,
        `PREP_PUBLICATION_HEAD_SHA='${f.candidate}'`,
        `push_prep_head_to_pr_branch 4242 topic '${hosted}' '${hosted}' .local/prepare-push-result.env "$(pr_gh pr view 4242)"`,
        `test "$PREP_PUBLICATION_LEASE_SHA" = '${hosted}'`,
        `test "$PREP_PUBLICATION_HEAD_SHA" = '${hosted}'`,
        'verify_correction_review_snapshot 4242 "$PREP_PUBLICATION_REVIEW_SNAPSHOT"',
      ].join("\n"),
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(resultPath, "utf8")).toBe(receipt);
    expect(f.read("events")).toBe("graphql\nproof\n");
  });

  it("does not admit an unnamed result path or pending sync publication", () => {
    const f = fixture();
    const unnamed = runCorrection(f, {
      command: [
        "source .local/prep-context.env",
        "PREP_PUBLICATION_REVIEW_SNAPSHOT=$(correction_review_snapshot 4242)",
        `push_prep_head_to_pr_branch 4242 topic '${f.candidate}' '${f.source}'`,
      ].join("\n"),
    });
    expect(unnamed.status, unnamed.stdout + unnamed.stderr).toBe(1);
    expect(unnamed.stderr).toContain("named preparation receipt");
    const sync = runCorrection(f, { command: "prepare_sync_head 4242" });
    expect(sync.status, sync.stdout + sync.stderr).toBe(1);
    expect(f.read("events")).toBe("");
    expect(f.hosted()).toBe(f.source);
    expectIncomplete(f);
  });
});
