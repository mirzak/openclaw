import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatCrabboxGateCheckSummary } from "../../scripts/pr-lib/crabbox-gate-contract.mjs";
import { validateCrabboxMergeBypass } from "../../scripts/pr-lib/crabbox-merge-bypass.mjs";
import { validReview } from "./pr-review-artifact-fixture.js";

const baseSha = "b".repeat(40);
const headSha = "a".repeat(40);
const workflowSha = "d".repeat(40);
const mainSha = "e".repeat(40);
const advancedMainSha = "f".repeat(40);
const planDigest = "c".repeat(64);
const runId = "run_abc123";
const leaseId = "cbx_def456";
const ciRunId = 7001;
const ciGateJobId = 7002;
const failedJobId = 7003;
const publisherPath = ".github/workflows/pr-crabbox-gate-publisher.yml";
const ciPath = ".github/workflows/ci.yml";
const ciGateName = "openclaw/ci-gate";

type WorkflowStep = {
  conclusion: string;
  name: string;
  status: string;
};

const completed = (conclusion: string) => ({ conclusion, status: "completed" });
const mainRef = () => ({ object: { sha: mainSha }, ref: "refs/heads/main" });
const check = (conclusion: string) => ({
  ...completed(conclusion),
  app: { id: 15368 },
  head_sha: headSha,
});
function workflow(id: number, path: string, event: string, head_sha: string, conclusion: string) {
  return { ...completed(conclusion), id, path, event, head_sha };
}
function gateSummary(testedBaseSha: string) {
  return formatCrabboxGateCheckSummary({
    baseSha: testedBaseSha,
    headSha,
    leaseId,
    planDigest,
    runId,
    targetCount: 8,
    workflowSha,
  });
}

function forwardComparison(sha: string, ahead_by = 4, diverged = false) {
  return {
    ahead_by,
    base_commit: { sha },
    behind_by: diverged ? 1 : 0,
    merge_base_commit: { sha: diverged ? baseSha : sha },
    status: diverged ? "diverged" : "ahead",
  };
}

function input(testedBaseSha = baseSha) {
  return {
    actor: { login: "maintainer" },
    baseComparison: forwardComparison(testedBaseSha),
    finalMainComparison: undefined,
    mainAdvanceComparison: undefined,
    pullMainComparison: undefined,
    checkRuns: {
      check_runs: [
        {
          ...check("skipped"),
          id: 20,
          name: ciGateName,
          details_url: `https://github.com/openclaw/openclaw/actions/runs/${ciRunId}/job/${ciGateJobId}`,
        },
        {
          ...check("success"),
          id: 21,
          name: "openclaw/crabbox-gate",
          details_url: "https://github.com/openclaw/openclaw/actions/runs/8001",
          output: { summary: gateSummary(testedBaseSha) },
        },
      ],
    },
    expectedBaseSha: testedBaseSha,
    expectedLeaseId: leaseId,
    expectedRunId: runId,
    headSha,
    jobs: {
      jobs: [
        {
          ...completed("skipped"),
          id: ciGateJobId,
          name: ciGateName,
        },
        {
          ...completed("failure"),
          id: failedJobId,
          labels: ["blacksmith-4vcpu-ubuntu-2404"],
          name: "check",
          runner_name: null as string | null,
          steps: [] as WorkflowStep[],
        },
      ],
    },
    membership: {
      role: "admin",
      state: "active",
      user: { login: "maintainer" },
    },
    finalMainRef: mainRef(),
    mainComparison: forwardComparison(workflowSha, 3),
    mainRef: mainRef(),
    pullRequest: {
      base: { ref: "main", repo: { full_name: "openclaw/openclaw" }, sha: mainSha },
      draft: false,
      head: { repo: { full_name: "openclaw/openclaw" }, sha: headSha },
      number: 131091,
      state: "open",
    },
    publisherRun: {
      ...workflow(8001, publisherPath, "workflow_dispatch", workflowSha, "success"),
      display_title: `PR Crabbox gate #131091 / ${headSha}`,
      head_branch: "main",
      run_attempt: 1,
    },
    requiredChecks: [{ bucket: "skipping", name: ciGateName, state: "SKIPPED" }],
    workflowRun: workflow(ciRunId, ciPath, "pull_request", headSha, "failure"),
  };
}

type Rejection = [string, (value: ReturnType<typeof input>) => void, RegExp];

describe("Crabbox admin merge bypass verifier", () => {
  it.each<Rejection>([
    [
      "missing Crabbox check",
      (v) => v.checkRuns.check_runs.pop(),
      /missing exact-head openclaw\/crabbox-gate/u,
    ],
    [
      "wrong app",
      (v) => (v.checkRuns.check_runs[1]!.app.id = 999),
      /app, or result does not match/u,
    ],
    ["stale SHA", (v) => (v.checkRuns.check_runs[1]!.head_sha = baseSha), /exact head/u],
    [
      "non-admin actor",
      (v) => (v.membership.role = "member"),
      /not an active openclaw organization admin/u,
    ],
    [
      "pull-ref publisher workflow",
      (v) => (v.publisherRun.path = `${publisherPath}@refs/pull/123/merge`),
      /not bound to the current protected-main publisher workflow/u,
    ],
    [
      "summary and publisher SHA mismatch",
      (v) => (v.publisherRun.head_sha = mainSha),
      /not bound to the current protected-main publisher workflow/u,
    ],
    [
      "protected main drift without ancestry evidence",
      (v) => (v.finalMainRef.object.sha = advancedMainSha),
      /final protected main advance is malformed/u,
    ],
    [
      "publisher workflow not ancestral to main",
      (v) => (v.mainComparison.merge_base_commit.sha = baseSha),
      /protected main is not identical or forward/u,
    ],
    [
      "non-canonical CI workflow path",
      (v) => (v.workflowRun.path = `${ciPath}@refs/pull/123/merge`),
      /normal CI workflow identity/u,
    ],
    [
      "failed workflow step with spoofed infrastructure text",
      (v) =>
        (v.jobs.jobs[1]!.steps = [
          {
            ...completed("failure"),
            name: "The hosted runner encountered an error",
          },
        ]),
      /has a failed workflow step/u,
    ],
    [
      "different retained preparation base",
      (v) => (v.expectedBaseSha = workflowSha),
      /expected broker proof/u,
    ],
    [
      "another unsatisfied required check",
      (v) => v.requiredChecks.push({ bucket: "fail", name: "security", state: "FAILURE" }),
      /only unsatisfied required check/u,
    ],
    [
      "a blocking job after a workflow step executed",
      (v) => (v.jobs.jobs[1]!.steps = [{ ...completed("success"), name: "product tests" }]),
      /only no-step outages may bypass/u,
    ],
    [
      "a zero-step failure after acquiring a runner",
      (v) => (v.jobs.jobs[1]!.runner_name = "Blacksmith runner"),
      /only unacquired outages may bypass/u,
    ],
    [
      "a zero-step cancelled job",
      (v) => (v.jobs.jobs[1]!.conclusion = "cancelled"),
      /conclusion is not a startup or provisioning outage/u,
    ],
    [
      "an intentionally cancelled workflow run",
      (v) => {
        v.workflowRun.conclusion = "cancelled";
        v.jobs.jobs[1]!.conclusion = "cancelled";
      },
      /normal CI workflow identity/u,
    ],
  ])("rejects %s", (_label, mutate, error) => {
    const value = input();
    mutate(value);
    expect(() => validateCrabboxMergeBypass(value)).toThrow(error);
  });

  it.each([
    { stage: "tested base to pull base", fault: "non-forward" },
    { stage: "tested base to pull base", fault: "missing comparison" },
    { stage: "tested base to pull base", fault: "strict mode" },
    { stage: "pull base to first main", fault: "non-forward" },
    { stage: "pull base to first main", fault: "missing comparison" },
    { stage: "pull base to first main", fault: "strict mode" },
  ])("rejects $stage with $fault", ({ stage, fault }) => {
    const pullToMain = stage === "pull base to first main";
    const value = input(pullToMain ? mainSha : baseSha);
    const comparison = {
      ahead_by: 1,
      base_commit: { sha: pullToMain ? mainSha : baseSha },
      behind_by: fault === "non-forward" ? 1 : 0,
      merge_base_commit: {
        sha: fault === "non-forward" ? headSha : pullToMain ? mainSha : baseSha,
      },
      status: fault === "non-forward" ? "diverged" : "ahead",
    };
    if (pullToMain) {
      value.mainRef.object.sha = advancedMainSha;
      value.finalMainRef.object.sha = advancedMainSha;
    }
    const evidence = {
      ...value,
      ...(pullToMain
        ? { pullMainComparison: fault === "missing comparison" ? undefined : comparison }
        : { baseComparison: fault === "missing comparison" ? undefined : comparison }),
      strictDrift: fault === "strict mode",
    };
    const error =
      fault === "strict mode"
        ? pullToMain
          ? "protected main moved during Crabbox merge validation"
          : "protected main moved from the tested Crabbox base"
        : `${pullToMain ? "protected main after pull request read" : "pull request base"} ${
            fault === "missing comparison" ? "is malformed" : "is not identical or forward"
          }`;
    expect(() => validateCrabboxMergeBypass(evidence)).toThrow(error);
  });

  it("accepts explicit protected-main workflow paths", () => {
    const value = input();
    value.publisherRun.path = `${publisherPath}@refs/heads/main`;
    value.workflowRun.path = `${ciPath}@refs/heads/main`;
    expect(validateCrabboxMergeBypass(value)).toMatchObject({
      actor: "maintainer",
      crabboxCheckId: 21,
      ciGateCheckId: 20,
      ciRunId,
      infrastructureJobs: [
        { backend: "blacksmith", conclusion: "failure", id: failedJobId, name: "check" },
      ],
      mainSha,
      planDigest,
      targetCount: 8,
      workflowSha,
    });
  });

  it("accepts a GitHub-classified workflow startup failure", () => {
    const value = input();
    value.workflowRun.conclusion = "startup_failure";
    value.jobs.jobs.splice(1);
    expect(validateCrabboxMergeBypass(value).infrastructureJobs).toEqual([
      {
        backend: "github-actions",
        conclusion: "startup_failure",
        id: ciRunId,
        name: "workflow startup",
      },
    ]);
  });
});

function runProtectedShell(
  command: string,
  {
    role = "admin",
    state = "active",
    denied = "",
    override = false,
    revoke = false,
    longPreview = false,
    advanceMain = false,
    nonForwardMain = false,
    nonAncestralPublisher = false,
    strictDrift = false,
    requalification = "",
    revokeDuringRequalification = false,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pr-crabbox-protected-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".local"));
  const review = validReview(headSha);
  review.pr.number = 131091;
  review.recommendation = "READY FOR /prepare-pr";
  review.issueValidation.status = "valid";
  writeFileSync(join(root, ".local/review.json"), JSON.stringify(review));
  writeFileSync(join(root, "calls.jsonl"), "");
  const evidence = {
    ...input(strictDrift ? mainSha : baseSha),
    currentMainSha: mainSha,
    materializedAdvance: requalification !== "materialization",
    advancedBaseComparison: forwardComparison(baseSha, 5),
    mainAdvanceComparison: forwardComparison(mainSha, 1, nonForwardMain),
    finalMainComparison: forwardComparison(workflowSha, 4, nonAncestralPublisher),
    // Exercise pipe backpressure during trailer parsing without changing authorization.
    mergePreview: "Reviewed fixture body".repeat(longPreview ? 16_384 : 1),
  };
  evidence.membership.role = role;
  evidence.membership.state = state;
  evidence.pullRequest.base.sha = mainSha;
  if (command.includes("finalize_remote_crabbox_aws_gate")) {
    evidence.checkRuns.check_runs[1]!.output!.summary = gateSummary(mainSha);
  }
  if (advanceMain) {
    evidence.finalMainRef.object.sha = advancedMainSha;
  }
  writeFileSync(join(root, "input.json"), JSON.stringify(evidence));
  const gh = join(bin, "gh");
  const protectedGh = `#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
const value = JSON.parse(fs.readFileSync("input.json", "utf8"));
const save = () => fs.writeFileSync("input.json", JSON.stringify(value));
const fail = (message, code = 19) => { console.error(message); process.exit(code); };
const out = (data) => console.log(typeof data === "string" ? data : JSON.stringify(data));
if (args[0] === "fixture-git") {
  if (args[1] === "fetch") {
    value.materializedAdvance = true;
    if (process.env.FAKE_REVOKE_DURING === "materialization") value.membership.role = "member";
    save(); process.exit(0);
  }
  const batch = args.some(arg => arg.startsWith("--batch-check"));
  const target = batch ? fs.readFileSync(0, "utf8").trim() : args.at(-1).replace(/\\^\\{commit\\}$/u, "");
  const missing = target === "${advancedMainSha}" && !value.materializedAdvance;
  if (batch) out(target + (missing ? " missing" : " commit"));
  else if (missing) fail("fatal: Not a valid object name " + target, 1);
  process.exit(0);
}
if (args[0] === "fixture-sleep") {
  value.requalificationSettled = true;
  if (process.env.FAKE_REVOKE_DURING === "settlement") value.membership.role = "member";
  save(); process.exit(0);
}
const apiOut = (data) => out(args.includes("--jq")
  ? cp.execFileSync("jq", ["-r", args[args.indexOf("--jq") + 1]], {input:JSON.stringify(data),encoding:"utf8"}).trim()
  : data);
const repo = {id:123,nameWithOwner:"openclaw/openclaw",url:"https://github.com/openclaw/openclaw"};
const repoNodeId = "fixture-repo";
const pr = {id:"fixture-pr",number:131091,url:repo.url+"/pull/131091",state:"OPEN",isDraft:false,
  headRefOid:value.headSha,headRefName:"topic",baseRefName:"main",baseRefOid:value.currentMainSha,
  headRepository:{name:"openclaw",nameWithOwner:repo.nameWithOwner,url:repo.url},headRepositoryOwner:{login:"openclaw"},
  isCrossRepository:false,mergeable:"MERGEABLE",mergeStateStatus:"BLOCKED",mergeCommit:null,
  autoMergeRequest:null,isInMergeQueue:false,isMergeQueueEnabled:false};
if (args.some(arg => /\\{(?:owner|repo)\\}/u.test(arg))) fail("unresolved repository placeholder");
const repositoryLocatorRequest = JSON.stringify(args) === JSON.stringify(["api", "--hostname", "github.com", "repos/openclaw/openclaw"]);
if (repositoryLocatorRequest) {
  if (process.env.FAKE_DENIED === "repos/openclaw/openclaw") fail("protected refusal");
  // Locator metadata cannot satisfy the separate authoritative ID binding.
  apiOut({full_name:repo.nameWithOwner,html_url:repo.url});
  process.exit(0);
}
const endpoint = args.find(arg => /^(?:repos\\/|orgs\\/|user$|graphql$)/u.test(arg));
if (args[0] === "api" && args.includes("repos/openclaw/openclaw") &&
    JSON.stringify(args) !== JSON.stringify(["api", "--hostname", "github.com", "repos/openclaw/openclaw", "-H", "Cache-Control: max-age=0"])) fail("unexpected repository authority request");
if (endpoint && endpoint === process.env.FAKE_DENIED) fail("protected refusal");
if (args[0] === "browse") out(repo.url);
else if (args[0] === "pr" && args[1] === "checks" && args.includes("--required")) {
  // gh v2.98.0 checks.go exports JSON before applying its human-output exit codes.
  out(value.requiredChecks);
} else if (args[0] === "pr" && args[1] === "merge") out("synthetic merge request accepted");
else if (args[0] === "workflow" && args[1] === "run") { value.dispatched = true; save(); }
else if (endpoint === "graphql" && args.some(arg => arg.includes("viewerMergeBodyText"))) {
  if (args.includes("--include")) process.stdout.write("HTTP/2.0 200 OK\\n\\n");
  out({data:{repository:{pullRequest:{...pr,viewerMergeHeadlineText:"Fixture merge headline",viewerMergeBodyText:value.mergePreview}}}});
}
else if (endpoint === "graphql" && args.some(arg => arg.includes("repository(owner:"))) {
  if (process.env.FAKE_REQUALIFICATION === "settlement" && value.requalificationStarted && !value.requalificationSettled) {
    pr.mergeable = "UNKNOWN";
    pr.mergeStateStatus = "UNKNOWN";
  }
  if (args.includes("--include")) process.stdout.write("HTTP/2.0 200 OK\\n\\n");
  out({data:{repository:{...repo,id:repoNodeId,databaseId:repo.id,ref:{target:{oid:value.currentMainSha}},pullRequest:pr}}});
} else if (endpoint === "user") {
  if (JSON.stringify(args) === JSON.stringify(["api", "user", "--include"])) out("HTTP/2.0 200 OK\\n\\n" + JSON.stringify(value.actor));
  else out(args[args.indexOf("--jq")+1] === ".login" ? "relay-reader" : {login:"relay-reader"});
} else {
  if (!endpoint) fail("unexpected command");
  // PR metadata reads replace the old gh view requests. Authorization
  // reads below retain their explicit freshness-header and pagination checks.
  const cacheableMetadata = [
    ["api", "--hostname", "github.com", "repos/openclaw/openclaw/pulls/131091"],
    ["api", "repos/openclaw/openclaw/pulls/131091", "--jq", ".head.sha"],
  ].some((request) => JSON.stringify(args) === JSON.stringify(request));
  const immutableCommitList = /^repos\\/openclaw\\/openclaw\\/commits\\?sha=[a-f0-9]{40}&per_page=1$/u.test(endpoint);
  const mutable = endpoint.startsWith("orgs/") ||
    (!process.env.FAKE_DISPATCH && !cacheableMetadata && !immutableCommitList && !/\\/compare\\/|\\/commits\\/[a-f0-9]{40}$/u.test(endpoint));
  if (mutable && !args.some((arg,i) => ["-H", "--header"].includes(arg) && args[i+1] === "Cache-Control: max-age=0")) fail("missing live header", 18);
  if (endpoint.includes("/check-runs?") || endpoint.includes("/jobs?") || endpoint.includes("/issues/131091/comments?")) {
    if (!args.includes("--paginate") || !args.includes("--slurp")) fail("missing pagination");
  }
  const prefix = "repos/openclaw/openclaw/";
  if (endpoint === "repos/openclaw/openclaw") {
    apiOut({id:repo.id,node_id:repoNodeId,full_name:repo.nameWithOwner,html_url:repo.url});
  }
  else if (endpoint === prefix + "pulls/131091") apiOut({...value.pullRequest,html_url:pr.url,
    base:{...value.pullRequest.base,repo:{id:repo.id,node_id:repoNodeId,html_url:repo.url,...value.pullRequest.base.repo}},
    head:{...value.pullRequest.head,ref:pr.headRefName,repo:{id:repo.id,name:"openclaw",html_url:repo.url,owner:{login:"openclaw"},...value.pullRequest.head.repo}}});
  else if (endpoint === prefix + "commits?sha=" + value.headSha + "&per_page=1") out([{sha:value.headSha,commit:{author:{name:"Fixture Contributor",email:"fixture@example.com"}},author:{login:"fixture-contributor",type:"User"}}]);
  else if (endpoint === prefix + "commits/" + value.headSha + "/check-runs?filter=latest&per_page=100") out(value.checkRuns.check_runs.map(check => ({check_runs:[check]})));
  else if (endpoint === prefix + "actions/workflows/pr-crabbox-gate-publisher.yml/runs") out({workflow_runs:value.dispatched ? [{...value.publisherRun,html_url:repo.url+"/actions/runs/8001",display_title:"PR Crabbox gate #131091 / "+value.headSha}] : []});
  else if (endpoint === prefix + "actions/runs/8001") out({...value.publisherRun,html_url:repo.url+"/actions/runs/8001"});
  else if (endpoint === prefix + "actions/runs/7001") out(value.workflowRun);
  else if (endpoint === prefix + "actions/runs/7001/jobs?filter=latest&per_page=100") out(value.jobs.jobs.map(job => ({jobs:[job]})));
  else if (endpoint === "orgs/openclaw/memberships/maintainer") {
    value.membershipReads = (value.membershipReads || 0) + 1;
    if (process.env.FAKE_REVOKE && value.membershipReads === 2) value.membership.role = "member";
    save(); out(value.membership);
  }
  else if (endpoint === "orgs/openclaw/memberships/relay-reader") out({role:"admin",state:"active",user:{login:"relay-reader"}});
  else if (endpoint === prefix + "git/ref/heads/main") {
    value.mainReads = (value.mainReads || 0) + 1;
    if (process.env.FAKE_REQUALIFICATION && value.mainReads === 3) {
      value.requalificationStarted = true;
      value.mainRef.object.sha = "${advancedMainSha}";
      value.finalMainRef.object.sha = "${advancedMainSha}";
    }
    const ref = value.mainReads === 1 ? value.mainRef : value.finalMainRef;
    value.currentMainSha = ref.object.sha;
    value.pullRequest.base.sha = value.currentMainSha;
    save(); out(ref);
  }
  else if (endpoint === prefix + "compare/${baseSha}...${mainSha}") out(value.baseComparison);
  else if (endpoint === prefix + "compare/${baseSha}...${advancedMainSha}") out(value.advancedBaseComparison);
  else if (endpoint === prefix + "compare/${workflowSha}...${mainSha}") out(value.mainComparison);
  else if (endpoint === prefix + "compare/${mainSha}...${advancedMainSha}") out(value.mainAdvanceComparison);
  else if (endpoint === prefix + "compare/${workflowSha}...${advancedMainSha}") out(value.finalMainComparison);
  else if (endpoint === "repos/prepared/base/commits/${headSha}") out({parents:[{sha:"${mainSha}"}]});
  else fail("unexpected endpoint: " + endpoint);
}
`;
  writeFileSync(gh, override ? "#!/bin/sh\nexit 19\n" : protectedGh);
  const selected = join(root, "selected-gh");
  writeFileSync(selected, protectedGh);
  chmodSync(gh, 0o755);
  chmodSync(selected, 0o755);
  // Keep all network-capable executables task-local, including explicit gh selection.
  // Node only substitutes the unrelated CI wait; both authorization verifiers run unchanged.
  for (const [name, body] of Object.entries({
    node: `case "$1" in */watch-pr-ci.mjs) exit 0;; esac\nexec '${process.execPath}' "$@"`,
    git: `if [ "$1" = -C ]; then shift 2; fi
    case "$1" in --git-dir=*) shift;; esac
    [ "$1" != --no-lazy-fetch ] || shift
    case "$1" in
      fetch|cat-file) case "$*" in
        *'${advancedMainSha}'*|*--batch-check*) exec '${process.execPath}' '${selected}' fixture-git "$@";;
        *) exit 0;;
      esac;;
      merge-base) exit 0;;
      config) [ "$*" = 'config --bool remote.origin.promisor' ] && exit 1; exit 19;;
      remote) [ "$2 $3" = 'get-url origin' ] || exit 19; echo 'https://github.com/openclaw/openclaw.git';;
      merge-tree) echo candidate-tree;;
      diff) case "$*" in
        'diff --name-only ${headSha}..${headSha}') ;;
        'diff --name-only ${headSha}..${mainSha}'|'diff --name-only ${headSha}..${advancedMainSha}') echo fixture-mainline.txt;;
        *) echo "unexpected fixture git: $*" >&2; exit 19;;
      esac;;
      rev-parse) case "$2" in
        --absolute-git-dir) printf '%s/.git\\n' "$PWD";;
        --verify) [ "$3" = 'refs/heads/pr-131091^{commit}' ] || exit 19; echo '${headSha}';;
        '${headSha}^1') echo '${mainSha}';;
        *) echo main-tree;;
      esac;;
      log) echo '${headSha}';;
      # The trailer parser writes stdin; drain it before exit to avoid EPIPE.
      -c) cat >/dev/null; exit 0;;
      *) echo "unexpected fixture git: $*" >&2; exit 19;;
    esac`,
    aws: "exit 19",
    crabbox: "exit 19",
  })) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(root, "clock"), "0\n");
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          `script_parent_dir='${process.cwd()}/scripts'`,
          'source "$script_parent_dir/lib/plain-gh.sh"',
          'for library in common worktree; do source "$script_parent_dir/pr-lib/$library.sh"; done',
          'repo_root() { printf "%s\\n" "$PWD"; }',
          'for library in gates merge review; do source "$script_parent_dir/pr-lib/$library.sh"; done',
          'pr_merge_now() { cat "$FIXTURE_CLOCK"; }',
          'pr_merge_sleep() { local now; read -r now < "$FIXTURE_CLOCK"; printf "%s\\n" "$((now + $1))" > "$FIXTURE_CLOCK"; command node "$FIXTURE_PROTECTED_GH" fixture-sleep "$@"; }',
          command,
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          HOME: root,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          GH_TOKEN: "synthetic-token",
          OPENCLAW_GH_BIN: override ? selected : "",
          OPENCLAW_PR_STRICT_DRIFT: strictDrift ? "1" : "",
          FAKE_DENIED: denied,
          FAKE_DISPATCH: command.includes("finalize_remote_crabbox_aws_gate") ? "1" : "",
          FAKE_REVOKE: revoke ? "1" : "",
          FAKE_REQUALIFICATION: requalification,
          FAKE_REVOKE_DURING: revokeDuringRequalification ? requalification : "",
          FIXTURE_PROTECTED_GH: selected,
          FIXTURE_CLOCK: join(root, "clock"),
          GATES_MODE: "remote_crabbox_aws",
          REMOTE_GATES_PROVIDER: "aws",
          FULL_GATES_HEAD_SHA: headSha,
          LAST_VERIFIED_HEAD_SHA: headSha,
          REMOTE_GATES_RUN_ID: runId,
          REMOTE_GATES_LEASE_ID: leaseId,
          REMOTE_GATES_BASE_SHA: evidence.expectedBaseSha,
          MERGE_REPO_NAME: "prepared/base",
        },
      },
    );
    const readArtifact = (name: string) => {
      const file = join(root, ".local", name);
      return existsSync(file) && readFileSync(file, "utf8").trim()
        ? JSON.parse(readFileSync(file, "utf8"))
        : undefined;
    };
    return {
      ...result,
      output: result.stdout + result.stderr,
      proof: readArtifact("merge-crabbox-bypass.json"),
      intent: readArtifact("intent.json"),
      gates: existsSync(join(root, ".local/gates.env"))
        ? readFileSync(join(root, ".local/gates.env"), "utf8")
        : undefined,
      calls: readFileSync(join(root, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type ShellResult = ReturnType<typeof runProtectedShell>;
const callsIncluding = (result: ShellResult, argument: string) =>
  result.calls.filter((args) => args.includes(argument));
const mergeRequests = (result: ShellResult) =>
  result.calls.filter((args) => args[0] === "pr" && args[1] === "merge");
function expectRefusal(result: ShellResult, error: string) {
  expect(result.status, result.output).toBe(1);
  expect(result.stderr).toContain(error);
}
function expectAcceptedMerge(result: ShellResult, membership: string[]) {
  const requests = mergeRequests(result);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("--admin");
  expect(result.calls.indexOf(requests[0]!)).toBeGreaterThan(result.calls.indexOf(membership));
  expect(result.intent).toMatchObject({ route: "admin", head: headSha, accepted: true });
  // A request acceptance is not a real merge receipt.
  expect(result.output).toContain("prior dispatch unresolved");
}

describe("Crabbox protected gh request producers", () => {
  it("accepts a forward final main advance with both ancestry proofs and preserves the first anchor", () => {
    const result = runProtectedShell(`verify_crabbox_admin_merge_bypass 131091 ${headSha}`, {
      advanceMain: true,
    });
    expect(result.status, result.output).toBe(0);
    expect(result.proof).toMatchObject({
      actor: "maintainer",
      mainSha,
      finalMainSha: advancedMainSha,
      workflowSha,
      ciRunId,
    });
    expect(result.calls.at(-1)).toContain("orgs/openclaw/memberships/maintainer");
    expect(result.calls.filter((args) => args.includes("--paginate"))).toHaveLength(2);
    expect(
      result.calls
        .map((args) => args.find((arg) => arg.includes("/compare/")))
        .filter(Boolean)
        .slice(-2),
    ).toEqual([
      `repos/openclaw/openclaw/compare/${mainSha}...${advancedMainSha}`,
      `repos/openclaw/openclaw/compare/${workflowSha}...${advancedMainSha}`,
    ]);
  });

  it.each([
    ["nonForwardMain", "final protected main advance is not identical or forward"],
    ["nonAncestralPublisher", "final protected main is not identical or forward"],
    ["strictDrift", "protected main moved during final Crabbox merge validation"],
  ] as const)("rejects main drift: %s", (option, error) => {
    const result = runProtectedShell(`verify_crabbox_admin_merge_bypass 131091 ${headSha}`, {
      advanceMain: true,
      [option]: true,
    });
    expectRefusal(result, error);
    expect(result.proof).toBeUndefined();
  });

  it("checks the explicitly selected writer's live admin membership", () => {
    const result = runProtectedShell("require_active_org_admin_for_crabbox_gate", {
      override: true,
    });
    expect(result.status, result.output).toBe(0);
    expect(result.stdout.trim()).toBe("maintainer");
  });

  it.each([{ role: "admin", state: "pending" }])(
    "rejects writer membership $state/$role despite the relay's admin identity",
    (membership) => {
      const result = runProtectedShell("require_active_org_admin_for_crabbox_gate", membership);
      expectRefusal(result, "requires an active openclaw organization admin");
    },
  );

  it("keeps protected refusal terminal without alternate identity or dispatch", () => {
    const result = runProtectedShell("require_active_org_admin_for_crabbox_gate", {
      denied: "user",
    });
    expectRefusal(result, "GitHub API preflight failed (HTTP unknown; exit=19)");
    expect(result.calls).toEqual([["api", "user", "--include"]]);
  });
});

// Replace local preparation and Git persistence only. merge_run, merge_verify,
// live identity/membership reads, bypass validation and the merge request remain real.
const mergeAuthorizationCommand = `
enter_worktree() { PR_MAIN_SHA=${mainSha}; }
refresh_main_snapshot() { PR_MAIN_SHA=${mainSha}; }
verify_prep_branch_matches_prepared_head() { :; }
review_artifact_preflight() { :; }
validate_review_artifact_data() { :; }
require_prepared_review() { :; }
mark_pr_operation_side_effects_started() { :; }
is_canonical_pr_number() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
merge_outcome_load_local() { MERGE_OUTCOME_OID=""; MERGE_OUTCOME_RECORD=""; }
merge_outcome_write() { MERGE_OUTCOME_RECORD="$1"; printf '%s\\n' "$1" > .local/intent.json; }
for artifact in pr-meta.env pr-meta.json prep.md; do
  echo fixture > ".local/$artifact"
done
printf '%s\\n' PREP_HEAD_SHA=${headSha} PREP_REPLACED_HOSTED_ANCESTRY=false PREP_AUTHOR_ACCESS=maintainer > .local/prep.env
echo GATES_MODE=remote_crabbox_aws > .local/gates.env
merge_run 131091
`;

describe("Crabbox authorization before final effects", () => {
  it.each(["member", "admin"])("gates remote dispatch on the authenticated %s", (role) => {
    const result = runProtectedShell(
      `PR_HEAD=topic
write_gates_env_stamp 131091 false false remote_crabbox_aws_pending ${headSha} '' '' aws '' '' ''
finalize_remote_crabbox_aws_gate 131091 ${headSha}`,
      { role },
    );
    expect(result.status, result.output).toBe(role === "admin" ? 0 : 1);
    const writer = result.calls.findIndex((args) => args.includes("user"));
    const membership = result.calls.findIndex((args) =>
      args.includes("orgs/openclaw/memberships/maintainer"),
    );
    const dispatches = result.calls.filter((args) => args[0] === "workflow" && args[1] === "run");
    expect(writer).toBeGreaterThanOrEqual(0);
    expect(result.calls[writer]).toEqual(["api", "user", "--include"]);
    expect(membership).toBeGreaterThan(writer);
    expect(result.calls.some((args) => args.includes("graphql"))).toBe(false);
    expect(mergeRequests(result)).toEqual([]);
    expect(dispatches).toHaveLength(role === "admin" ? 1 : 0);
    if (role === "admin") {
      expect(result.gates).toContain(`REMOTE_GATES_BASE_SHA=${mainSha}`);
      expect(result.gates).toContain("REMOTE_GATES_ACTIONS_RUN_ATTEMPT=1");
      expect(result.calls.indexOf(dispatches[0]!)).toBeGreaterThan(membership);
      expect(dispatches[0]).toEqual([
        "workflow",
        "run",
        "pr-crabbox-gate-publisher.yml",
        "--ref",
        "main",
        "-f",
        "pr_number=131091",
        "-f",
        `head_sha=${headSha}`,
        "-f",
        `base_sha=${mainSha}`,
      ]);
    } else {
      expect(result.gates).toContain("GATES_MODE=remote_crabbox_aws_pending");
      expect(result.gates).not.toContain("PENDING_CRABBOX_STATE");
      expect(result.stderr).toContain("requires an active openclaw organization admin");
    }
  });

  it.each([
    { role: "member", revoke: false, reads: 1, merges: 0, longPreview: false },
    { role: "admin", revoke: false, reads: 2, merges: 1, longPreview: true },
    { role: "admin", revoke: true, reads: 2, merges: 0, longPreview: false },
  ])(
    "gates admin merge on $role membership (revoked=$revoke, long preview=$longPreview)",
    ({ role, revoke, reads, merges, longPreview }) => {
      const result = runProtectedShell(mergeAuthorizationCommand, { role, revoke, longPreview });
      const output = result.output;
      expect(result.status, output).toBe(1);
      const writers = callsIncluding(result, "user");
      const memberships = callsIncluding(result, "orgs/openclaw/memberships/maintainer");
      const requests = mergeRequests(result);
      expect(writers, output).toEqual(
        Array.from({ length: reads }, () => ["api", "user", "--include"]),
      );
      expect(memberships).toHaveLength(reads);
      expect(requests).toHaveLength(merges);
      expect(result.calls.some((args) => args[0] === "workflow")).toBe(false);
      if (merges) {
        expect(requests[0]).toEqual([
          "pr",
          "merge",
          "131091",
          "--repo",
          "https://github.com/openclaw/openclaw",
          "--squash",
          "--admin",
          "--match-head-commit",
          headSha,
          "--body-file",
          expect.any(String),
          "--subject",
          "Fixture merge headline",
        ]);
        expectAcceptedMerge(result, memberships[1]!);
      } else {
        expect(output).toContain("maintainer is not an active openclaw organization admin");
        expect(result.intent).toBeUndefined();
      }
      if (revoke) {
        expect(output).toContain("merge-verify passed for PR #131091");
      }
    },
  );

  it.each([
    { requalification: "materialization", revokeDuringRequalification: false },
    { requalification: "materialization", revokeDuringRequalification: true },
    { requalification: "settlement", revokeDuringRequalification: false },
    { requalification: "settlement", revokeDuringRequalification: true },
  ])(
    "rechecks live Crabbox authority after $requalification (revoked=$revokeDuringRequalification)",
    ({ requalification, revokeDuringRequalification }) => {
      const result = runProtectedShell(mergeAuthorizationCommand, {
        requalification,
        revokeDuringRequalification,
      });
      const output = result.output;
      const boundary = result.calls.findIndex((args) =>
        requalification === "materialization"
          ? args[0] === "fixture-git" && args[1] === "fetch"
          : args[0] === "fixture-sleep",
      );
      const finalMembership = result.calls.findLastIndex((args) =>
        args.includes("orgs/openclaw/memberships/maintainer"),
      );
      const requests = mergeRequests(result);
      expect(boundary, output).toBeGreaterThan(-1);
      expect(finalMembership, output).toBeGreaterThan(boundary);
      expect(result.status, output).toBe(1);
      if (revokeDuringRequalification) {
        expect(requests, output).toHaveLength(0);
        expect(result.intent).toBeUndefined();
        expect(output).toContain("maintainer is not an active openclaw organization admin");
      } else {
        expectAcceptedMerge(result, result.calls[finalMembership]!);
        expect(result.intent).toMatchObject({ main: mainSha });
        expect(result.proof).toMatchObject({ finalMainSha: advancedMainSha });
        expect(
          result.calls
            .slice(finalMembership + 1)
            .some(
              (args) =>
                args[0] === "fixture-sleep" || (args[0] === "fixture-git" && args[1] === "fetch"),
            ),
        ).toBe(false);
      }
    },
  );
});
