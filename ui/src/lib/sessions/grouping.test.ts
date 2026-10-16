// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  groupSidebarSessionRows,
  groupSessionRows,
  moveSessionSection,
  normalizeSessionSectionOrder,
  normalizeSessionsGroupBy,
  normalizeSidebarSessionsGrouping,
  UNGROUPED_ID,
} from "./grouping.ts";

type Actor = NonNullable<GatewaySessionRow["owner"]>["actor"];
function actor(id: string, label?: string, type: "human" | "agent" = "human"): Actor {
  return {
    type,
    id,
    label,
    identity: { type: type === "human" ? "profile" : "agent", id: id.trim() },
  };
}
function ownedRow(key: string, ownerActor: Actor, fields: Partial<GatewaySessionRow> = {}) {
  return row({ key, ...fields, owner: { actor: ownerActor } });
}
function groupKeys(groups: { id: string; rows: GatewaySessionRow[] }[]) {
  return groups.map(({ id, rows }) => [id, rows.map(({ key }) => key)]);
}

describe("groupSidebarSessionRows", () => {
  it("groups owners by identity even when they share a checkout", () => {
    const workContext = { name: "shared", path: "/repos/shared" };
    const owned = (key: string, owner: Actor) => ownedRow(key, owner, { workContext });
    const sections = groupSidebarSessionRows(
      [
        owned("remote", {
          ...actor("current", "Ada"),
          identity: {
            type: "remote",
            pluginId: "chat",
            domain: "users",
            idKind: "user",
            id: "current",
          },
        }),
        owned("agent", actor("current", "Aaron", "agent")),
        owned("former", {
          ...actor("former", "Zoe"),
          identity: { type: "profile", id: "current" },
        }),
        owned("current", actor("current")),
      ],
      { grouping: "person", selfOwnerId: "current" },
    ).filter((section) => section.rows.length > 0);
    expect(sections.map((section) => section.rows.map((item) => item.key))).toEqual([
      ["former", "current"],
      ["remote"],
      ["agent"],
    ]);
    expect(sections[0]).toMatchObject({
      id: "person:profile:current",
      personOwner: { id: "current", identity: { type: "profile", id: "current" } },
    });
    expect(new Set(sections.map((section) => section.id)).size).toBe(3);
  });

  it("orders pinned, categories, threads, groups, then coding while preserving row order", () => {
    const rows = [
      row({ key: "z-1", category: "Zulu" }),
      row({ key: "p-1", pinned: true, category: "Alpha" }),
      row({ key: "a-1", category: "Alpha" }),
      row({ key: "u-1" }),
      row({ key: "g-1", kind: "group" }),
      row({ key: "wt-1", workSession: true }),
      row({ key: "a-2", category: "Alpha" }),
    ];

    const sections = groupSidebarSessionRows(rows);

    expect(groupKeys(sections)).toEqual([
      ["pinned", ["p-1"]],
      ["category:Alpha", ["a-1", "a-2"]],
      ["category:Zulu", ["z-1"]],
      ["ungrouped", ["u-1"]],
      ["groups", ["g-1"]],
      ["work", ["wt-1"]],
    ]);
    expect(sections[4]?.groups).toBe(true);
    expect(sections[5]?.work).toBe(true);
  });

  it("flattens the kind-based zones into one list when grouping is none", () => {
    const sections = groupSidebarSessionRows(
      [
        row({ key: "tg", channel: "telegram", channelSession: true }),
        row({ key: "wt", workSession: true }),
        row({ key: "grp", kind: "group" }),
        row({ key: "pin", pinned: true }),
      ],
      { grouping: "none" },
    );
    expect(groupKeys(sections)).toEqual([
      ["pinned", ["pin"]],
      ["ungrouped", ["tg", "wt", "grp"]],
      ["work", []],
    ]);
  });

  it("buckets rows by work checkout and leaves checkout-less rows in their smart zones", () => {
    const openclaw = { name: "openclaw", path: "/repos/openclaw" };
    const sections = groupSidebarSessionRows(
      [
        row({ key: "z-1", workContext: { name: "zulu", path: "/repos/zulu" } }),
        row({ key: "oc-1", workContext: openclaw, workSession: true }),
        row({ key: "thread" }),
        row({ key: "fork-1", workContext: { name: "openclaw", path: "/forks/openclaw" } }),
        row({ key: "grp", kind: "group" }),
        row({ key: "no-repo", workSession: true }),
        row({ key: "oc-2", category: "Ignored", workContext: openclaw }),
        row({
          key: "oc-wt",
          workContext: { name: "c7c338", path: "/repos/openclaw/.claude/worktrees/c7c338" },
        }),
        row({ key: "oc-slash", workContext: { name: "openclaw", path: "/repos/openclaw/" } }),
        row({ key: "pin", pinned: true, workContext: openclaw }),
      ],
      { grouping: "project", knownGroups: ["Ignored"] },
    );

    expect(groupKeys(sections)).toEqual([
      ["pinned", ["pin"]],
      ["project:/forks/openclaw", ["fork-1"]],
      ["project:/repos/openclaw", ["oc-1", "oc-2", "oc-wt", "oc-slash"]],
      ["project:/repos/zulu", ["z-1"]],
      ["ungrouped", ["thread"]],
      ["groups", ["grp"]],
      ["work", ["no-repo"]],
    ]);
    expect(sections[2]?.project).toEqual(openclaw);
  });

  it("orders owner sections before stored zones and leaves ownerless rows in their smart zones", () => {
    const sections = groupSidebarSessionRows(
      [
        ownedRow("agent", actor("agent-z", "Zed", "agent")),
        ownedRow("owned-group", actor("profile-b", "Bea"), { kind: "group", category: "Ignored" }),
        row({ key: "thread" }),
        row({ key: "group", kind: "group" }),
        row({ key: "work", workSession: true }),
        ownedRow("human-a", actor("profile-a", "Ada")),
        ownedRow("self", { ...actor("profile-self", "Zoe"), avatarUrl: "/avatars/self" }),
        ownedRow("agent-a", actor("agent-a", "Alpha", "agent")),
        row({ key: "blank-owner", owner: { actor: { type: "human", id: "   " } } }),
        row({ key: "pinned", pinned: true, owner: { actor: { type: "human", id: "profile-a" } } }),
      ],
      {
        grouping: "person",
        selfOwnerId: "profile-self",
        knownGroups: ["Ignored"],
        catalogIds: ["catalog"],
        sectionOrder: [
          "work",
          "person:profile:profile-b",
          "groups",
          "ungrouped",
          "catalog:catalog",
        ],
      },
    );

    expect(groupKeys(sections)).toEqual([
      ["pinned", ["pinned"]],
      ["person:profile:profile-self", ["self"]],
      ["person:profile:profile-a", ["human-a"]],
      ["person:profile:profile-b", ["owned-group"]],
      ["person:agent:agent-a", ["agent-a"]],
      ["person:agent:agent-z", ["agent"]],
      ["work", ["work"]],
      ["groups", ["group"]],
      ["ungrouped", ["thread", "blank-owner"]],
      ["catalog:catalog", []],
    ]);
    expect(sections[1]?.personOwner).toEqual({
      type: "human",
      id: "profile-self",
      identity: { type: "profile", id: "profile-self" },
      label: "Zoe",
      avatarUrl: "/avatars/self",
    });
  });

  it("keeps stored-but-empty known groups visible as sections", () => {
    const sections = groupSidebarSessionRows(
      [row({ key: "a" }), row({ key: "b", category: "Zulu" })],
      { knownGroups: ["Apps", " ", "Zulu"] },
    );
    expect(groupKeys(sections)).toEqual([
      ["category:Apps", []],
      ["category:Zulu", ["b"]],
      ["ungrouped", ["a"]],
      ["work", []],
    ]);
  });

  it("applies stored cross-section order after pinned rows", () => {
    const sections = groupSidebarSessionRows(
      [
        row({ key: "pin", pinned: true }),
        row({ key: "a", category: "Alpha" }),
        row({ key: "thread" }),
        row({ key: "group", kind: "group" }),
      ],
      { sectionOrder: ["work", "groups", "ungrouped", "category:Alpha"] },
    );
    expect(sections.map((section) => section.id)).toEqual([
      "pinned",
      "work",
      "groups",
      "ungrouped",
      "category:Alpha",
    ]);
  });

  it("appends sections missing from stored order in default relative order", () => {
    const sections = groupSidebarSessionRows(
      [row({ key: "a", category: "Alpha" }), row({ key: "thread" })],
      { sectionOrder: ["work"] },
    );
    expect(sections.map((section) => section.id)).toEqual(["category:Alpha", "work", "ungrouped"]);
  });
});

it("normalizeSessionSectionOrder builds the default order from an empty stored value", () => {
  expect(normalizeSessionSectionOrder([], ["Alpha", "Beta"])).toEqual([
    "category:Alpha",
    "category:Beta",
    "ungrouped",
    "groups",
    "work",
  ]);
});

describe("moveSessionSection", () => {
  const order = ["category:Alpha", "category:Beta", "ungrouped", "groups", "work"];

  it("moves a section before or after its target", () => {
    const moves = [
      { from: "category:Beta", to: "work", side: "before", expected: [0, 2, 3, 1, 4] },
      { from: "category:Alpha", to: "groups", side: "after", expected: [1, 2, 3, 0, 4] },
    ] as const;
    for (const { from, to, side, expected } of moves) {
      expect(moveSessionSection(order, from, to, side)).toEqual(
        expected.map((index) => order[index]),
      );
    }
  });

  it("leaves self and unknown moves unchanged", () => {
    expect(moveSessionSection(order, "category:Alpha", "category:Alpha", "after")).toEqual(order);
    expect(moveSessionSection(order, "category:Missing", "work", "before")).toEqual(order);
    expect(moveSessionSection(order, "category:Alpha", "missing", "before")).toEqual(order);
  });
});

it("normalizeSidebarSessionsGrouping accepts supported modes and falls back to category", () => {
  expect(
    ["none", "person", "project", "category", null, "bogus"].map(normalizeSidebarSessionsGrouping),
  ).toEqual(["none", "person", "project", "category", "category", "category"]);
});

type ZoneRowExtras = {
  workSession?: boolean;
  acpSession?: boolean;
  channelSession?: boolean;
  workContext?: { name: string; path: string };
};

function row(
  overrides: Partial<GatewaySessionRow> & ZoneRowExtras & { key: string },
): GatewaySessionRow & ZoneRowExtras {
  return { kind: "direct", updatedAt: null, ...overrides };
}

it("normalizeSessionsGroupBy accepts known modes and falls back to none", () => {
  expect(["category", "person", "date", "bogus", null].map(normalizeSessionsGroupBy)).toEqual([
    "category",
    "person",
    "date",
    "none",
    "none",
  ]);
});

describe("groupSessionRows", () => {
  it.each(["UTC", "America/Los_Angeles", "America/Santiago"])(
    "groups complete local calendar days in %s",
    (timeZone) => {
      // Worker-thread TZ mutations do not reliably change V8's timezone. Start a
      // process in the requested zone so real calendar/DST behavior owns the proof.
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `
          import { groupSessionRows } from ${JSON.stringify(new URL("./grouping.ts", import.meta.url).href)};
          const dates = [[2026, 0, 1], [2026, 2, 9], [2026, 10, 2], [2026, 8, 6], [2026, 8, 7]];
          const results = dates.map(([year, month, day]) => {
            const at = (daysAgo, hour = 0, minute = 0) =>
              new Date(year, month, day - daysAgo, hour, minute).getTime();
            const rows = [
              ["today", at(0)], ["yesterday", at(1)],
              ["two-days-ago", at(2, 23, 59)], ["six-days-ago", at(6)],
              ["older", at(7, 23, 59)], ["unknown", null],
            ].map(([key, updatedAt]) => ({ key, updatedAt, kind: "direct" }));
            return groupSessionRows({ mode: "date", now: at(0, 12), rows })
              .map((group) => [group.id, group.rows.map((row) => row.key)]);
          });
          process.stdout.write(JSON.stringify(results));
        `,
        ],
        {
          cwd: new URL("../../../../", import.meta.url),
          env: { ...process.env, TZ: timeZone },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      const expected = [
        ["today", ["today"]],
        ["yesterday", ["yesterday"]],
        ["week", ["two-days-ago", "six-days-ago"]],
        ["older", ["older"]],
        [UNGROUPED_ID, ["unknown"]],
      ];
      expect(JSON.parse(output)).toEqual(Array.from({ length: 5 }, () => expected));
    },
  );

  it("keeps known categories in order, appends extras, and puts ungrouped last", () => {
    const rows = [
      row({ key: "a", category: "Zulu" }),
      row({ key: "b", category: "Research" }),
      row({ key: "c" }),
    ];
    const groups = groupSessionRows({
      rows,
      mode: "category",
      knownCategories: ["Research", "Empty"],
    });
    expect(groups.map((group) => group.id)).toEqual(["Research", "Empty", "Zulu", UNGROUPED_ID]);
    expect(groups[1]?.rows).toEqual([]);
    expect(groups[3]?.rows.map((r) => r.key)).toEqual(["c"]);
  });

  it("groups channel sessions alphabetically with unparseable keys last", () => {
    const rows = [
      row({ key: "agent:main:telegram:direct:1" }),
      row({ key: "agent:main:discord:channel:2" }),
      row({ key: "global", kind: "global" }),
    ];
    const groups = groupSessionRows({ rows, mode: "channel" });
    expect(groups.map((group) => group.id)).toEqual(["discord", "telegram", UNGROUPED_ID]);
  });

  it("groups sessions by their durable owner identity and leaves ownerless sessions last", () => {
    const groups = groupSessionRows({
      rows: [
        ownedRow("bob", actor("profile-b", "Bob")),
        row({ key: "ownerless" }),
        ownedRow("ada", actor(" profile-a ", "Ada")),
        row({ key: "blank", owner: { actor: { type: "human", id: " " } } }),
      ],
      mode: "person",
    });

    expect(groups.map((group) => group.id)).toEqual([
      "profile:profile-a",
      "profile:profile-b",
      UNGROUPED_ID,
    ]);
    expect(groups[2]?.rows.map((item) => item.key)).toEqual(["ownerless", "blank"]);
  });
});
