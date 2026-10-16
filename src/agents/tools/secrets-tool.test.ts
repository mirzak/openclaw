import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import {
  QuestionRequestParamsSchema,
  QuestionResolveParamsSchema,
  QuestionWaitAnswerParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/questions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SecretRefSchema } from "../../config/zod-schema.core.js";
import { QuestionManager, QuestionManagerError } from "../../gateway/question-manager.js";
import { isEmbeddedMode, setEmbeddedMode } from "../../infra/embedded-mode.js";
import {
  EmbeddedQuestionBroker,
  clearEmbeddedQuestionBroker,
  setEmbeddedQuestionBroker,
} from "../../infra/embedded-question-broker.js";
import { isBuiltInDefaultSecretProviderRef } from "../../secrets/ref-contract.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { claimPendingAgentQuestionAnswer } from "../harness/gateway-question.js";
import { reserveAskUserPromptDelivery, settleAskUserPromptDelivery } from "./ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./ask-user-tool.test-support.js";
import { createSecretsTool, normalizeSecretsRequestParams } from "./secrets-tool.js";

type GatewayCall = NonNullable<Parameters<typeof createSecretsTool>[0]["gatewayCall"]>;
type GatewayImplementation = (
  method: string,
  opts: Record<string, unknown>,
  params: Record<string, unknown>,
  extra?: { signal?: AbortSignal; requireAgentRuntimeIdentity?: boolean },
) => Promise<unknown>;

function gatewayStub(implementation: GatewayImplementation) {
  const mock = vi.fn(implementation);
  return { mock, call: mock as unknown as GatewayCall };
}

function questionManagerGateway(
  manager: QuestionManager,
  onRequest: (request: Parameters<QuestionManager["request"]>[0]) => unknown,
) {
  return gatewayStub(async (method, _options, params) => {
    try {
      if (method === "question.request") {
        const request = Value.Parse(QuestionRequestParamsSchema, params);
        return onRequest({ ...request, timeoutMs: request.timeoutMs ?? 60_000 });
      }
      if (method === "question.resolve") {
        const request = Value.Parse(QuestionResolveParamsSchema, params);
        if (!("cancel" in request)) {
          throw new Error("expected question cancellation");
        }
        return manager.cancel(request.id, request.resolvedBy);
      }
      if (method === "question.waitAnswer") {
        const request = Value.Parse(QuestionWaitAnswerParamsSchema, params);
        return manager.waitAnswer(request.id, request.timeoutMs);
      }
      throw new Error(`unexpected method ${method}`);
    } catch (error) {
      if (error instanceof QuestionManagerError) {
        throw new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: error.message,
          details: { reason: error.code },
        });
      }
      throw error;
    }
  });
}

function requestedQuestionId(mock: ReturnType<typeof gatewayStub>["mock"]): string {
  const request = mock.mock.calls.find(([method]) => method === "question.request");
  const questionId = request?.[2].id;
  if (typeof questionId !== "string") {
    throw new Error("question.request did not include an id");
  }
  return questionId;
}

const storedAnswer = { status: "answered", answers: { answers: { secret_value: ["stored"] } } };
const secretRequest = { action: "request", name: "SERVICE_API_KEY", kind: "secret" };
const proposedBinding = {
  name: "SERVICE_API_KEY",
  kind: "secret",
  allowedHosts: ["api.example.test"],
  reason: "Deploy the service",
};
const proposedRequest = { action: "request", ...proposedBinding };
const secretQuestion = {
  questionId: "secret_value",
  header: "API key",
  question: "Provide the secret for SERVICE_API_KEY.",
  options: [],
  isSecret: true,
  secretStore: proposedBinding,
};
function secretTool(
  gateway: ReturnType<typeof gatewayStub>,
  options: Omit<Parameters<typeof createSecretsTool>[0], "gatewayCall"> = {},
) {
  return createSecretsTool({ ...options, gatewayCall: gateway.call });
}

function methodCalls(gateway: ReturnType<typeof gatewayStub>, method: string) {
  return gateway.mock.mock.calls.filter(([called]) => called === method);
}
const storeMetadata = {
  name: "SERVICE_API_KEY",
  createdAtMs: 0,
  updatedAtMs: 0,
  scopeKind: "team",
  scopeId: "",
};
const editedPolicy = { status: "available", allowedHosts: ["api.analytics.example"] };
const secretEntry = { ...storeMetadata, kind: "secret", allowedHosts: editedPolicy.allowedHosts };
const unrelatedEnv = {
  ...storeMetadata,
  name: "UNRELATED_ENV",
  kind: "env",
  value: "private-env-value",
};

function requestGateway(handlers: Record<string, GatewayImplementation | undefined>) {
  return gatewayStub(async (method, _options, params, extra) => {
    if (method === "question.request") {
      return { id: params.id };
    }
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`unexpected method ${method}`);
    }
    return handler(method, _options, params, extra);
  });
}

function storedRequestGateway(readMetadata: () => Promise<unknown>) {
  return requestGateway({
    "question.waitAnswer": async () => storedAnswer,
    "secrets.store.list": readMetadata,
  });
}

function waitingStoredRequestGateway(allowMetadata = true) {
  const answer = createDeferred<unknown>();
  const waiting = createDeferred();
  const gateway = requestGateway({
    "question.waitAnswer": async () => {
      waiting.resolve();
      return await answer.promise;
    },
    "secrets.store.list": allowMetadata
      ? async () => ({ entries: [unrelatedEnv, secretEntry] })
      : undefined,
  });
  return { gateway, answer, waiting: waiting.promise };
}

function expectStoredDetails(details: unknown, currentPolicy: unknown, provider = "default") {
  expect(details).toEqual({
    status: "stored",
    name: "SERVICE_API_KEY",
    kind: "secret",
    ref: { source: "store", provider, id: "SERVICE_API_KEY" },
    currentPolicy,
  });
}

function promptOptions(
  sessionKey: string,
  send: NonNullable<Parameters<typeof createSecretsTool>[0]["questionPrompt"]>["send"],
  messageChannel = "telegram",
) {
  return {
    config: { gateway: { publicOrigin: "https://ops.example.test" } },
    sessionKey,
    questionPrompt: { send, messageChannel },
  };
}

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
});

describe("secrets request normalization", () => {
  it("builds one store-bound secret question and clamps its timeout", () => {
    const normalized = normalizeSecretsRequestParams({
      ...proposedRequest,
      timeoutSeconds: 5,
    });

    expect(normalized).toEqual({
      name: "SERVICE_API_KEY",
      timeoutSeconds: 30,
      questions: [secretQuestion],
    });
    expect(
      normalizeSecretsRequestParams({
        name: "SERVICE_SETTING",
        kind: "secret",
        timeoutSeconds: 9_999,
      }).timeoutSeconds,
    ).toBe(3_600);
    expect(
      Value.Check(createSecretsTool({}).parameters, {
        action: "set",
        name: "SERVICE_API_KEY",
        value: "test-secret-value-123",
      }),
    ).toBe(false);
  });

  it.each([
    ["lowercase names", { name: "bad_name", kind: "secret" }, "uppercase"],
    [
      "environment-value requests the model could read back",
      { name: "VALID_NAME", kind: "env" },
      'kind must be "secret"',
    ],
    [
      "duplicate allowed hosts",
      { name: "VALID_NAME", kind: "secret", allowedHosts: ["a.test", "a.test"] },
      "unique",
    ],
    [
      "oversized reasons",
      { name: "VALID_NAME", kind: "secret", reason: "r".repeat(201) },
      "at most 200",
    ],
    ["fractional timeouts", { name: "VALID_NAME", kind: "secret", timeoutSeconds: 1.5 }, "integer"],
  ])("rejects %s before contacting the gateway", (_label, params, message) => {
    expect(() => normalizeSecretsRequestParams(params)).toThrow(message);
  });
});

describe("secrets tool", () => {
  it("returns a clear local store blocker without publishing a credential prompt", async () => {
    const previousMode = isEmbeddedMode();
    const broker = new EmbeddedQuestionBroker(createTestGatewayScheduler());
    const events: string[] = [];
    broker.subscribe((event) => events.push(event.event));
    setEmbeddedMode(true);
    setEmbeddedQuestionBroker(broker);
    try {
      await expect(
        createSecretsTool({ sessionKey: "agent:main:main" }).execute("local-secret", {
          action: "request",
          name: "SERVICE_API_KEY",
        }),
      ).rejects.toThrow(
        "Secret store requests need a running Gateway; ask the operator to run `openclaw secrets store` or use the Control UI.",
      );
      expect(events).toEqual([]);
      expect(broker.list().questions).toEqual([]);
    } finally {
      clearEmbeddedQuestionBroker(broker);
      broker.stop();
      setEmbeddedMode(previousMode);
    }
  });

  it("returns a valid shared-default store ref without claiming chat text", async () => {
    const config: OpenClawConfig = {
      secrets: {
        defaults: { store: "teamstore" },
        providers: { teamstore: { source: "env" } },
      },
    };
    const { gateway, answer, waiting } = waitingStoredRequestGateway();
    const tool = secretTool(gateway, {
      config,
      agentId: "main",
      sessionKey: "agent:main:secrets",
      runId: "run-secrets",
    });
    const pending = tool.execute("call-secret", proposedRequest);
    await waiting;

    await expect(
      claimPendingAgentQuestionAnswer({
        sessionKey: "agent:main:secrets",
        text: "test-secret-value-123",
      }),
    ).resolves.toBe(false);
    answer.resolve(storedAnswer);
    const result = await pending;

    const ref = SecretRefSchema.parse(asNullableRecord(result.details)?.ref);
    expect(ref).toMatchObject({ source: "store", id: "SERVICE_API_KEY" });
    expect(isBuiltInDefaultSecretProviderRef(config, ref)).toBe(true);
    expectStoredDetails(result.details, editedPolicy, "teamstore");
    for (const guidance of [
      "Use the returned ref",
      "this entry's current host list; the human may edit it",
      "Not Gateway config or an approval receipt; may change later",
      "Report current hosts, not proposed hosts",
      "Do not infer why they differ or prescribe Gateway config changes from the difference",
    ]) {
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining(guidance) });
    }
    expect(JSON.stringify(result)).not.toMatch(
      /test-secret-value-123|api\.example\.test|UNRELATED_ENV|private-env-value/,
    );
    expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual([
      "question.request",
      "question.waitAnswer",
      "secrets.store.list",
    ]);
    expect(gateway.mock).toHaveBeenLastCalledWith("secrets.store.list", {}, {}, undefined);
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.request",
      {},
      expect.objectContaining({
        id: expect.stringMatching(/^ask_[a-f0-9]{32}$/),
        agentId: "main",
        sessionKey: "agent:main:secrets",
        runId: "run-secrets",
        timeoutMs: 900_000,
        questions: [expect.objectContaining(secretQuestion)],
      }),
      // Store-bound minting is admin-gated server-side; the tool must declare
      // the scope explicitly instead of the questions-scope default.
      { scopes: ["operator.admin"], requireAgentRuntimeIdentity: true },
    );
  });

  it.each(["pending", "cancelled"] as const)(
    "returns no_answer when a credential request is %s",
    async (status) => {
      const gateway = requestGateway({
        "question.waitAnswer": async () => ({ status }),
        "question.resolve": async () => ({ status }),
      });

      const result = await secretTool(gateway, { sessionKey: `agent:main:${status}` }).execute(
        `call-${status}`,
        secretRequest,
      );

      expect(result.details).toEqual({ status: "no_answer" });
      expect(methodCalls(gateway, "secrets.store.list")).toHaveLength(0);
      if (status === "pending") {
        expect(gateway.mock).toHaveBeenCalledWith(
          "question.resolve",
          { timeoutMs: 10_000 },
          {
            id: requestedQuestionId(gateway.mock),
            cancel: true,
            resolvedBy: "wait-timeout",
          },
        );
      }
    },
  );

  it.each([
    { boundary: "wait timeout", marker: "stored", abort: false },
    { boundary: "delivery failure", marker: "stored", abort: false },
    { boundary: "delivery failure", marker: "unexpected", abort: false },
    { boundary: "delivery failure", marker: "stored", abort: true },
  ])(
    "consumes canonical answers after $boundary (marker=$marker, abort=$abort)",
    async ({ boundary, marker, abort }) => {
      const terminal = Object.assign(new Error("question is already answered"), {
        name: "GatewayClientRequestError",
        details: { reason: "QUESTION_ALREADY_TERMINAL" },
      });
      const sessionKey = "agent:main:late-answer";
      const toolCallId = "call-late-answer";
      const normalized = normalizeSecretsRequestParams(secretRequest);
      const reservation =
        boundary === "delivery failure"
          ? reserveAskUserPromptDelivery({
              toolCallId,
              sessionKey,
              questions: normalized.questions,
              timeoutSeconds: normalized.timeoutSeconds,
            })
          : undefined;
      const firstWait = createDeferred<unknown>();
      const controller = new AbortController();
      let waitCalls = 0;
      const gateway = requestGateway({
        "question.resolve": async () => {
          if (abort) {
            await Promise.resolve();
            controller.abort(new Error("run stopped"));
          }
          throw terminal;
        },
        "secrets.store.list": async () => ({ entries: [secretEntry] }),
        "question.waitAnswer": async () => {
          if (++waitCalls === 1) {
            return boundary === "wait timeout" ? { status: "pending" } : await firstWait.promise;
          }
          return { status: "answered", answers: { answers: { secret_value: [marker] } } };
        },
      });
      const outcome = secretTool(gateway, { sessionKey })
        .execute(toolCallId, secretRequest, controller.signal)
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      try {
        if (reservation) {
          await vi.waitFor(() => expect(waitCalls).toBe(1));
          settleAskUserPromptDelivery(reservation.questionId, new Error("transport failed"));
        }
        if (abort) {
          await expect(outcome).resolves.toMatchObject({ error: new Error("run stopped") });
        } else if (marker !== "stored") {
          await expect(outcome).resolves.toMatchObject({
            error: new Error("credential request returned an unexpected answer marker"),
          });
        } else {
          await expect(outcome).resolves.toMatchObject({
            result: {
              details: { status: "stored", name: "SERVICE_API_KEY", currentPolicy: editedPolicy },
            },
          });
        }
        expect(methodCalls(gateway, "secrets.store.list")).toHaveLength(
          !abort && marker === "stored" ? 1 : 0,
        );
        expect(methodCalls(gateway, "question.resolve")).toHaveLength(1);
      } finally {
        firstWait.resolve({ status: "cancelled" });
        await outcome;
      }
    },
  );

  const longHost = `${"a".repeat(62)}.${"b".repeat(62)}.${"c".repeat(62)}.${"d".repeat(59)}.test`;
  const oversizedHosts = [longHost, `e${longHost.slice(1)}`];
  it.each([
    [
      "513-character array",
      { entries: [{ ...secretEntry, allowedHosts: oversizedHosts }] },
      { status: "omitted", allowedHostCount: 2 },
    ],
    [
      "absent host policy",
      { entries: [{ ...storeMetadata, kind: "secret" }] },
      { status: "unavailable" },
    ],
    ["missing entry", { entries: [unrelatedEnv] }, { status: "missing" }],
    [
      "kind changed to env",
      { entries: [{ ...unrelatedEnv, name: storeMetadata.name }] },
      { status: "kind_changed" },
    ],
    ["read rejection", new Error("private-env-value"), { status: "unavailable" }],
    [
      "invalid secret fields",
      { entries: [{ ...secretEntry, value: "private-env-value" }] },
      { status: "unavailable" },
    ],
  ])("preserves stored truth with %s metadata", async (_label, metadata, currentPolicy) => {
    const gateway = storedRequestGateway(async () => {
      if (metadata instanceof Error) {
        throw metadata;
      }
      return metadata;
    });
    const result = await secretTool(gateway).execute("policy-result", {
      action: "request",
      name: "SERVICE_API_KEY",
      allowedHosts: ["proposed.example.test"],
    });
    expectStoredDetails(result.details, currentPolicy);
    expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual([
      "question.request",
      "question.waitAnswer",
      "secrets.store.list",
    ]);
    const text = result.content[0];
    expect(text?.type).toBe("text");
    if (text?.type !== "text") {
      throw new Error("expected text result");
    }
    expect(text.text.length).toBeLessThan(1800);
    expect(text.text).not.toMatch(/private-env-value|UNRELATED_ENV|proposed\.example\.test/);
    expect(text.text).not.toContain(longHost.slice(0, 62));
    expect(text.text).not.toContain("allowedHosts");
  });

  it.each(["resolve", "reject"] as const)(
    "keeps abort authoritative when metadata %ss",
    async (settlement) => {
      const metadata = createDeferred<unknown>();
      const controller = new AbortController();
      const gateway = storedRequestGateway(() => metadata.promise);
      const outcome = secretTool(gateway)
        .execute("abort-policy", { action: "request", name: "SERVICE_API_KEY" }, controller.signal)
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      try {
        await vi.waitFor(() =>
          expect(methodCalls(gateway, "secrets.store.list").length).toBeGreaterThan(0),
        );
        expect(gateway.mock).toHaveBeenLastCalledWith(
          "secrets.store.list",
          {},
          {},
          { signal: controller.signal },
        );
        controller.abort(new Error("run stopped during metadata"));
        if (settlement === "reject") {
          metadata.reject(new Error("private-env-value"));
        } else {
          metadata.resolve({ entries: [secretEntry] });
        }
        await expect(outcome).resolves.toEqual({ error: new Error("run stopped during metadata") });
      } finally {
        controller.abort();
        metadata.resolve({ entries: [secretEntry] });
        await outcome;
      }
    },
  );

  it("cancels a registered credential request when its agent run aborts", async () => {
    const controller = new AbortController();
    const gateway = requestGateway({
      "question.resolve": async () => ({ status: "cancelled" }),
      "question.waitAnswer": async (_method, _options, _params, extra) =>
        new Promise((_resolve, reject) => {
          extra?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    const pending = secretTool(gateway, { sessionKey: "agent:main:secret-abort" }).execute(
      "call-secret-abort",
      secretRequest,
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(methodCalls(gateway, "question.waitAnswer").length).toBeGreaterThan(0),
    );

    controller.abort(new Error("stop"));

    await expect(pending).rejects.toThrow("aborted");
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.resolve",
      { timeoutMs: 10_000 },
      { id: requestedQuestionId(gateway.mock), cancel: true, resolvedBy: "run-abort" },
    );
  });

  it.each([
    {
      label: "a lost transport reply",
      error: new Error("registration reply lost"),
      abort: false,
      answered: false,
      refused: false,
    },
    {
      label: "an aborted registration reply",
      error: new Error("registration interrupted"),
      abort: true,
      answered: false,
      refused: false,
    },
    {
      label: "a human answer before the failed registration reply",
      error: new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "registration response unavailable",
      }),
      abort: false,
      answered: true,
      refused: false,
    },
    {
      label: "a refused registration with an ID owned by another requester",
      error: Object.assign(new Error("registration refused"), {
        name: "GatewayClientRequestError",
        details: { reason: "QUESTION_ID_IN_USE" },
      }),
      abort: true,
      answered: false,
      refused: true,
    },
  ])(
    "preserves question truth and the original error after $label",
    async ({ error, abort, answered, refused }) => {
      const manager = new QuestionManager(createTestGatewayScheduler());
      const controller = new AbortController();
      const sessionKey = "agent:main:secret-registration";
      const normalized = normalizeSecretsRequestParams(secretRequest);
      const reservation = refused
        ? reserveAskUserPromptDelivery({
            toolCallId: "call-registration",
            sessionKey,
            questions: normalized.questions,
          })
        : undefined;
      if (refused && !reservation) {
        throw new Error("expected prompt reservation");
      }
      const unrelated = structuredClone(
        manager.request({
          id: reservation?.questionId ?? "unrelated-question",
          questions: normalized.questions,
          sessionKey: "agent:main:other-requester",
          timeoutMs: 60_000,
        }),
      );
      const transitions: string[] = [];
      const gateway = questionManagerGateway(manager, (request) => {
        if (refused) {
          controller.abort(new Error("run stopped"));
          throw error;
        }
        const record = manager.request({
          ...request,
          onResolved: (event) => {
            transitions.push(event.status);
          },
        });
        if (answered) {
          manager.resolve(record.id, storedAnswer.answers, "operator:human");
        }
        if (abort) {
          controller.abort(new Error("run stopped"));
        }
        throw error;
      });

      try {
        await expect(
          secretTool(gateway, { sessionKey }).execute(
            "call-registration",
            secretRequest,
            controller.signal,
          ),
        ).rejects.toBe(error);

        if (!refused) {
          expect(manager.get(requestedQuestionId(gateway.mock))).toMatchObject(
            answered
              ? { status: "answered", answers: storedAnswer.answers, resolvedBy: "operator:human" }
              : { status: "cancelled" },
          );
        }
        expect(transitions).toEqual(refused ? [] : [answered ? "answered" : "cancelled"]);
        expect(manager.get(unrelated.id)).toEqual(unrelated);
        expect(methodCalls(gateway, "question.resolve")).toHaveLength(refused ? 0 : 1);
        expect(methodCalls(gateway, "question.request")).toHaveLength(1);
        expect(methodCalls(gateway, "secrets.store.list")).toHaveLength(0);
        expect(
          reserveAskUserPromptDelivery({
            toolCallId: "call-after-registration",
            sessionKey,
            questions: normalized.questions,
          }),
        ).toBeDefined();
      } finally {
        manager.close();
      }
    },
  );

  it.each([
    ["telegram", true],
    ["control-ui-only", false],
  ] as const)(
    "publishes an unreserved credential link only on deliverable %s",
    async (channel, deliver) => {
      const sent: { text?: string; channelData?: unknown }[] = [];
      const { gateway, answer, waiting } = waitingStoredRequestGateway(deliver);
      const pending = secretTool(
        gateway,
        promptOptions(
          "agent:main:secret-direct-dispatch",
          (payload) => {
            sent.push(payload);
          },
          channel,
        ),
      ).execute("call-secret-direct", secretRequest);
      await waiting;
      if (deliver) {
        await vi.waitFor(() => expect(sent).toHaveLength(1));
      }
      answer.resolve(deliver ? storedAnswer : { status: "expired" });
      await expect(pending).resolves.toMatchObject({
        details: { status: deliver ? "stored" : "no_answer" },
      });
      if (deliver) {
        expect(sent[0]?.text).toContain("https://ops.example.test/ask/");
        expect(sent[0]?.text).toContain("SERVICE_API_KEY");
      } else {
        expect(sent).toEqual([]);
      }
    },
  );

  it("ends credential publication before post-answer metadata finishes", async () => {
    let capturedSignal: AbortSignal | undefined;
    let aborted = false;
    const answer = createDeferred<unknown>();
    const metadataStarted = createDeferred();
    const metadata = createDeferred<{ entries: (typeof secretEntry)[] }>();
    const gateway = requestGateway({
      "question.waitAnswer": async () => answer.promise,
      "secrets.store.list": async () => {
        metadataStarted.resolve();
        return metadata.promise;
      },
    });
    const pending = secretTool(
      gateway,
      promptOptions("agent:main:secret-direct-dispatch-abort", (_payload, options) => {
        capturedSignal = options?.signal;
        return new Promise<void>(() => {});
      }),
    ).execute("call-secret-direct-abort", secretRequest);

    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    capturedSignal?.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );
    answer.resolve(storedAnswer);
    try {
      await metadataStarted.promise;
      expect(aborted).toBe(true);
    } finally {
      metadata.resolve({ entries: [secretEntry] });
      await expect(pending).resolves.toMatchObject({ details: { status: "stored" } });
    }
  });

  it("lists store metadata and environment previews", async () => {
    const entries = [
      {
        ...storeMetadata,
        kind: "secret",
        allowedHosts: ["api.example.test"],
        updatedBy: "operator:alice",
      },
      {
        ...storeMetadata,
        name: "SERVICE_MODE",
        kind: "env",
        value: "preview-value",
      },
    ];
    const gateway = gatewayStub(async () => ({ entries }));

    const result = await secretTool(gateway).execute("call-list", {
      action: "list",
    });

    expect(result.details).toEqual({ entries });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("SERVICE_API_KEY | secret | hosts: api.example.test"),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("value: preview-value"),
    });
    expect(gateway.mock).toHaveBeenCalledWith("secrets.store.list", {}, {}, undefined);
  });

  it("requires verified agent runtime identity when deleting a store entry", async () => {
    const gateway = gatewayStub(async () => ({ ok: true, reloaded: false }));

    const result = await secretTool(gateway).execute("call-delete", {
      action: "delete",
      name: "SERVICE_API_KEY",
    });

    expect(result.details).toEqual({ ok: true, reloaded: false });
    expect(gateway.mock).toHaveBeenCalledWith(
      "secrets.store.delete",
      {},
      { name: "SERVICE_API_KEY" },
      { requireAgentRuntimeIdentity: true },
    );
  });
});
