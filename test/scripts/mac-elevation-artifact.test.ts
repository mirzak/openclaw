import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, vi } from "vitest";
import {
  addon,
  artifactFixture,
  buildInfo,
  library,
  peekabooCommit,
  sourceCommit,
  runtimeDist,
  runtimeRoot,
  write,
} from "./mac-elevation-artifact.test-support.js";
import {
  compiledMacNativeFixtures,
  macFatContainerFixture,
  macObjectFixture,
  runMacFixtureTool,
  singleSliceMacFat64,
} from "./mac-native-fixtures.test-support.js";
import { type MacScriptFixture, createMacScriptTest } from "./mac-script-fixture.test-support.js";

const it = createMacScriptTest();
const sharedLibrary = "Contents/Frameworks/shared [fixture].dylib";
const runtimeBun = `${runtimeRoot}/bin/bun`;
const runtimeAddon = `${runtimeRoot}/${addon}`;
const runtimeSqlite = `${runtimeRoot}/lib/libsqlite3.dylib`;
const runtimeCli = `${runtimeRoot}/lib/node_modules/openclaw/openclaw.mjs`;
const runtimeMetadata = `${runtimeRoot}/${runtimeDist}/build-info.json`;
const nativeFormat = "elevation code lacks native signature format:";
const metadataDiagnostic = "elevation runtime build metadata does not match app:";
const armv7Path = `${runtimeRoot}/lib/object-resource are: arm64 x86_64\nNon-fat file: injected is architecture: arm64`;
const signatureDiagnostic = "must be signed for every architecture";
const archCommand = (arch: string) => `codesign -dv --verbose=4 --arch ${arch}`;
type Artifact = Awaited<ReturnType<typeof artifactFixture>> & {
  tool: (command: string, args: string[]) => Promise<string>;
  fat: (slices: Buffer[], fat64?: boolean) => Promise<Buffer>;
  code: () => Promise<void>;
};

type Contents =
  | keyof Artifact["binaries"]
  | ((h: Artifact, mac: MacScriptFixture) => Buffer | Promise<Buffer>)
  | null;
type Mutation = readonly [string, string, Contents, string | RegExp, number?];
const nonUniversal = "elevation Mach-O is not universal:";
const missingSlices = "could not inspect elevation code slices:";
const foreignNative = "elevation runtime contains non-Mach-O native code:";
const thinBun = "elevation runtime binary lacks native x86_64 code:";
const unsupportedArchDiagnostic = "elevation runtime Mach-O has no supported architecture:";
const incompleteRuntime =
  /elevation runtime payload is incomplete|broken or cyclic elevation runtime symlink/;
const slice =
  (arch: "arm64" | "x86_64"): Contents =>
  (h, mac) =>
    singleSliceMacFat64(h.home, arch, mac);
const fatLibrary: Contents = (h) => h.fat([h.binaries.armLibrary, h.binaries.intelLibrary], true);
const armv7: Contents = async (h, mac) => {
  const bytes = Buffer.from(await macObjectFixture(h.home, "arm64", mac));
  bytes.writeUInt32LE(12, 4); // Synthetic ARMv7 resource; never executed.
  bytes.writeUInt32LE(9, 8);
  return bytes;
};

function withArtifact(mac: MacScriptFixture, body: (artifact: Artifact) => Promise<void>) {
  return mac.lifetime.run(async () => {
    const h = await artifactFixture(mac);
    await body({
      ...h,
      tool: (command, args) => runMacFixtureTool(command, args, h.home, mac),
      fat: (slices, fat64 = false) => macFatContainerFixture(h.home, slices, fat64, mac),
      code: async () => {
        const result = await h.verifyCode();
        expect(result, result.stderr).toMatchObject({
          status: 0,
          stdout: "Elevation code verified\n",
        });
      },
    });
  });
}

async function verify(
  artifact: Artifact,
  diagnostic?: string | RegExp,
  fault = "",
  status = diagnostic ? 1 : 0,
) {
  const result = await artifact.verify(fault);
  expect(result.status, result.stderr).toBe(status);
  if (diagnostic) {
    if (typeof diagnostic === "string") {
      expect(result.stderr).toContain(diagnostic);
    } else {
      expect(result.stderr).toMatch(diagnostic);
    }
    expect(result.stdout).not.toContain("Elevation artifact verified");
  } else {
    expect(result.stdout).toContain("Elevation artifact verified");
  }
  return result;
}

const machResourceKinds = [
  "object",
  "synthetic-core",
  "synthetic-dylib-stub",
  "synthetic-dsym",
] as const;

async function resources(
  h: Artifact,
  mac: MacScriptFixture,
  kind: "archive" | "object",
): Promise<[Buffer, Buffer]> {
  if (kind === "archive") {
    return [h.binaries.armArchive, h.binaries.intelArchive];
  }
  return [
    await macObjectFixture(h.home, "arm64", mac),
    await macObjectFixture(h.home, "x86_64", mac),
  ];
}

function snapshot(targets: string[]) {
  return targets.map((target) => ({
    target,
    bytes: readFileSync(target),
    mode: statSync(target).mode & 0o777,
  }));
}

function expectPreserved(files: ReturnType<typeof snapshot>) {
  for (const { target, bytes, mode } of files) {
    expect(readFileSync(target), target).toEqual(bytes);
    expect(statSync(target).mode & 0o777, target).toBe(mode);
  }
}

function withMachResourceKind(
  contents: Buffer,
  kind: (typeof machResourceKinds)[number] | "archive",
) {
  if (kind === "archive") {
    return contents;
  }
  const bytes = Buffer.from(contents);
  // lipo -create ignores MH_CORE inputs. Build real object containers first, then
  // change only their object header kinds: these are synthetic controls, not dumps.
  const filetypes = {
    object: 1,
    "synthetic-core": 4,
    "synthetic-dylib-stub": 9,
    "synthetic-dsym": 10,
  };
  const magic = bytes.readUInt32BE(0);
  const offsets = [0];
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const fat64 = magic === 0xcafebabf;
    expect(bytes.readUInt32BE(4)).toBe(2);
    offsets.length = 0;
    for (let index = 0; index < 2; index++) {
      const entry = 8 + index * (fat64 ? 32 : 20);
      offsets.push(
        fat64 ? Number(bytes.readBigUInt64BE(entry + 8)) : bytes.readUInt32BE(entry + 8),
      );
    }
  }
  for (const offset of offsets) {
    expect(bytes.readUInt32BE(offset)).toBe(0xcffaedfe);
    if (bytes.readUInt32LE(offset + 12) === 1) {
      bytes.writeUInt32LE(filetypes[kind], offset + 12);
    }
  }
  return bytes;
}

describe.skipIf(process.platform !== "darwin")(
  "portable elevation native artifact verification",
  () => {
    // The following archive case owns a new lifetime and must prepare successfully
    // after this failed flight; keep the failure probe ahead of the concurrent cases.
    it("rejects all borrowers of a failed native preparation", ({ mac }) =>
      mac.lifetime.run(async () => {
        const root = mac.createTempDir("openclaw-native-preparation-failure-");
        const tool = vi.spyOn(mac, "run").mockResolvedValueOnce({
          status: 1,
          signal: null,
          error: undefined,
          stdout: "",
          stderr: "injected native preparation failure",
        });
        try {
          const results = await Promise.allSettled([
            compiledMacNativeFixtures(root, mac),
            macObjectFixture(root, "arm64", mac),
          ]);
          const rejected = {
            status: "rejected",
            reason: expect.objectContaining({
              message: expect.stringContaining("injected native preparation failure"),
            }),
          };
          expect(results).toEqual([rejected, rejected]);
          expect(tool).toHaveBeenCalledTimes(1);
        } finally {
          tool.mockRestore();
        }
      }));

    it.concurrent("verifies a complete archive outside the checkout", async ({ mac }) =>
      withArtifact(mac, async (h) => {
        const result = await h.verify();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          `Elevation artifact verified: source=${sourceCommit} peekaboo=${peekabooCommit}`,
        );
        const calls = readFileSync(h.calls, "utf8");
        expect(
          calls.match(/^codesign --verify --deep --strict --all-architectures /gm),
        ).toHaveLength(1);
        expect(calls.match(/^helper-authority=.*$/gm)).toEqual(["helper-authority=:"]);
        expect(calls.indexOf("candidate-helper-hash")).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf("candidate-helper-hash")).toBeLessThan(
          calls.indexOf("codesign --verify --deep"),
        );
        expect(calls).toContain("codesign -dv --verbose=4 --arch arm64 ");
        expect(calls).toContain("codesign -dv --verbose=4 --arch x86_64 ");
        expect(calls).toContain("codesign --verify --strict --test-requirement==notarized ");
        expect(calls).toContain("xcrun stapler validate ");
        expect(calls).toContain("spctl --assess --type execute ");
        expect(calls).toContain(`/${addon}`);
        expect(calls).toContain(`/${library}`);
      }));

    it.concurrent.for(["extra-entry", "regular-file", "symlink"])(
      "rejects an archive with an invalid app root (%s) before authenticating a helper",
      async (kind, { mac }) =>
        withArtifact(mac, async (h) => {
          if (kind === "extra-entry") {
            await write(path.join(path.dirname(h.app), "unexpected"), "not app content\n");
          } else {
            const reference = path.join(h.home, "reference.app");
            await rename(h.app, reference);
            if (kind === "symlink") {
              await symlink(reference, h.app);
            } else {
              await write(h.app, "not an app directory\n");
            }
          }
          await verify(h, "elevation archive root");
          const calls = readFileSync(h.calls, "utf8");
          expect(calls).not.toContain("candidate-helper-hash");
          expect(calls).not.toContain("codesign --verify");
        }),
    );

    it.concurrent("accepts universal runtime slices with contained terminal links", async ({
      mac,
    }) =>
      withArtifact(mac, async (h) => {
        const bun = h.at(runtimeBun);
        await rename(bun, `${bun}-real\n`);
        await symlink("bun-real\n", bun);
        await verify(h);
      }));

    it.concurrent("batches native classification for 80 resources", async ({ mac }) =>
      withArtifact(mac, async (h) => {
        for (let index = 0; index < 80; index++) {
          await write(
            h.at(`${runtimeRoot}/nested/win32/resource [*]?\n${index}.js`),
            `// harmless platform resource ${index}\n`,
          );
        }
        const result = await h.verifyCode();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("Elevation code verified\n");
        const count = h.fileCallCount();
        console.info(`portable verifier: 80 resources, ${count} file classifier invocations`);
        // Allow different batch sizes, but never one process per resource.
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThanOrEqual(12);
        expect(readFileSync(h.calls, "utf8")).toContain(`/${addon}`);
      }));

    const malformed = () => Buffer.from("cafebabf", "hex");
    const mutations: Mutation[] = [
      ["fat64 slice", sharedLibrary, slice("arm64"), nonUniversal],
      ["fat64 signature", runtimeBun, slice("x86_64"), nativeFormat],
      ["fat64 signature", runtimeSqlite, slice("arm64"), nativeFormat, 0o644],
      ["malformed fat64", sharedLibrary, malformed, missingSlices],
      ["malformed fat64", runtimeAddon, malformed, missingSlices],
      ["raw-fat64 signature", "Contents/MacOS/OpenClaw", "fat64", nativeFormat],
      ["raw-fat64 signature", runtimeAddon, fatLibrary, nativeFormat, 0o644],
      ["misleading architecture filename", armv7Path, armv7, unsupportedArchDiagnostic, 0o644],
      ["thin runtime Bun", runtimeBun, "arm64", thinBun],
      ["missing CLI", runtimeCli, null, incompleteRuntime],
      [
        "Node binary",
        "Contents/Resources/legacy/bin/node",
        "universal",
        "elevation app must not contain Node:",
      ],
      ["thin shared code", sharedLibrary, "armLibrary", nonUniversal],
      ["nonexecutable ELF", runtimeAddon, "elf", foreignNative, 0o644],
      ["nonexecutable PE", runtimeAddon, "pe", foreignNative, 0o644],
      ["nonexecutable COFF", runtimeAddon, "coff", foreignNative, 0o644],
    ];
    it.concurrent.for(mutations)(
      "rejects %s at %s",
      async ([, relative, contents, diagnostic, mode = 0o755], { mac }) =>
        withArtifact(mac, async (h) => {
          if (contents === null) {
            await rm(h.at(relative));
          } else {
            const bytes =
              typeof contents === "function" ? await contents(h, mac) : h.binaries[contents];
            await write(h.at(relative), bytes, mode);
          }
          const result = await verify(h, diagnostic);
          expect(result.stderr).toContain(relative);
        }),
    );

    it.concurrent.for(
      (["archive", "object"] as const).flatMap((resource) =>
        [false, true].flatMap((fat64) =>
          [false, true].map((archiveFirst) => ({ resource, fat64, archiveFirst })),
        ),
      ),
    )(
      "rejects mixed $resource/native containers (fat64=$fat64, archiveFirst=$archiveFirst)",
      async ({ resource, fat64, archiveFirst }, { mac }) =>
        withArtifact(mac, async (h) => {
          const [armResource, intelResource] = await resources(h, mac, resource);
          const mixed = await h.fat(
            archiveFirst
              ? [h.binaries.armLibrary, intelResource]
              : [armResource, h.binaries.intelLibrary],
            fat64,
          );
          await write(h.at(runtimeAddon), withMachResourceKind(mixed, resource));
          await verify(
            h,
            `mixed ${resource === "archive" ? "archive" : "resource"}/native elevation code:`,
          );
        }),
    );

    it.concurrent("rejects malformed sibling slices in fat containers", async ({ mac }) =>
      withArtifact(mac, async (h) => {
        const bytes = Buffer.from(h.binaries.universalArchive);
        expect(bytes.readUInt32BE(0)).toBe(0xcafebabe);
        expect(bytes.readUInt32BE(8)).toBe(0x01000007); // x86_64 comes first in lipo output.
        bytes.fill(0, bytes.readUInt32BE(16), bytes.readUInt32BE(16) + 8);
        await write(h.at(runtimeAddon), bytes);
        const result = await verify(h, "invalid elevation code slice:");
        expect(result.stderr).toContain(`${runtimeRoot}/${addon} (x86_64)`);
      }));

    it.concurrent.for(
      (["archive", "object"] as const).flatMap((resource) =>
        ["thin", "fat32", "fat64"].map((format) => ({ resource, format })),
      ),
    )(
      "rejects $resource resources posing as Bun ($format)",
      async ({ resource, format }, { mac }) =>
        withArtifact(mac, async (h) => {
          const [arm, intel] = await resources(h, mac, resource);
          const bytes = format !== "thin" ? await h.fat([arm, intel], format === "fat64") : arm;
          await write(h.at(runtimeBun), withMachResourceKind(bytes, resource), 0o755);
          const result = await h.verify(`${resource}-bun`);
          expect(result.status, result.stderr).toBe(1);
          expect(result.stdout).not.toContain("Elevation artifact verified");
          expect(result.stderr).toContain(
            format === "thin" && resource === "archive"
              ? "elevation runtime binary must be Mach-O:"
              : "/runtime/bin/bun",
          );
        }),
    );

    it.concurrent.for([
      ...machResourceKinds.map((resource) => ({ resource, format: "thin" })),
      { resource: "object", format: "fat32" },
      { resource: "synthetic-core", format: "fat64" },
    ] as const)(
      "accepts $format $resource resources without changing bytes or modes",
      async ({ resource, format }, { mac }) =>
        withArtifact(mac, async (h) => {
          const objects = {
            arm64: await macObjectFixture(h.home, "arm64", mac),
            x86_64: await macObjectFixture(h.home, "x86_64", mac),
          };
          const universal =
            format === "thin"
              ? undefined
              : await h.fat([objects.arm64, objects.x86_64], format === "fat64");
          const preserved = [];
          for (const arch of ["arm64", "x86_64"] as const) {
            for (const mode of [0o644, 0o755]) {
              const target = h.at(`${runtimeRoot}/lib/object-resource ${arch} [*]\n${mode}.dylib`);
              const bytes = withMachResourceKind(universal ?? objects[arch], resource);
              await write(target, bytes, mode);
              preserved.push({ target, bytes, mode });
            }
          }
          await verify(h);
          await h.code();
          expectPreserved(preserved);
          const calls = readFileSync(h.calls, "utf8");
          expect(calls).toContain("codesign --verify --deep --strict --all-architectures");
          expect(
            calls
              .split("\n")
              .filter(
                (line) =>
                  line.startsWith("codesign -dv --verbose=4") && line.includes("object-resource"),
              ),
          ).toEqual([]);
        }),
    );

    it.concurrent.for(["empty", "missing-member"].map((kind) => ({ kind })))(
      "rejects $kind GNU thin archives in $arch",
      async ({ kind }, { mac }) =>
        withArtifact(mac, async (h) => {
          const header = [
            "missing.o/".padEnd(16),
            "0".padEnd(12),
            "0".padEnd(6),
            "0".padEnd(6),
            "100644".padEnd(8),
            "0".padEnd(10),
            "`\n",
          ].join("");
          const target = h.at(`${runtimeRoot}/lib/opaque [*].resource`);
          await write(target, `!<thin>\n${kind === "empty" ? "" : header}`);
          expect(await h.tool("/usr/bin/file", ["-b", target])).toContain("thin archive with");
          await verify(h, "elevation runtime contains unsupported thin archive:");
        }),
    );

    it.concurrent("preserves native code, archives, tar and Java resources", async ({ mac }) =>
      withArtifact(mac, async (h) => {
        await write(path.join(h.home, "ordinary.txt"), "ordinary resource\n");
        const tar = path.join(h.home, "ordinary.tar");
        await h.tool("/usr/bin/tar", [
          "--format",
          "ustar",
          "-cf",
          tar,
          "-C",
          h.home,
          "ordinary.txt",
        ]);
        expect(await h.tool("/usr/bin/file", ["-b", tar])).toBe("POSIX tar archive");
        const targets = [sharedLibrary, runtimeBun, runtimeAddon];
        for (const relative of targets) {
          await write(
            h.at(relative),
            h.binaries.universal,
            relative.endsWith(addon) ? 0o644 : 0o755,
          );
        }
        // Shared slice enforcement retains find -perm -111 semantics, not just -x.
        for (const mode of [0o644, 0o700, 0o750]) {
          await write(h.at(`Contents/Frameworks/thin-${mode}.dylib`), h.binaries.armLibrary, mode);
        }
        const archive64 = await h.fat([h.binaries.armArchive, h.binaries.intelArchive], true);
        await write(h.at(`${runtimeRoot}/ordinary.resource`), readFileSync(tar));
        await write(h.at(`${runtimeRoot}/lib/universal.a`), h.binaries.universalArchive);
        await write(h.at(`${runtimeRoot}/lib/archive64 [*]`), archive64);
        await write(
          h.at(`${runtimeRoot}/Example.class`),
          Buffer.from("cafebabe0000003400010001000000000000000000000000", "hex"),
        );
        const preserved = snapshot(
          [
            ...targets,
            "Contents/MacOS/OpenClaw",
            "Contents/MacOS/openclaw-mlx-tts",
            ...[0o644, 0o700, 0o750].map((mode) => `Contents/Frameworks/thin-${mode}.dylib`),
            ...[
              library,
              "lib/native.a",
              "lib/universal.a",
              "lib/archive64 [*]",
              "Example.class",
              "ordinary.resource",
            ].map((relative) => `${runtimeRoot}/${relative}`),
          ].map(h.at),
        );
        await verify(h);
        // verifyCode receives this tree; verify above inspects a separate ZIP extraction.
        await h.code();
        expectPreserved(preserved);
      }));

    it.concurrent.for([[runtimeRoot, "Contents/Resources/Runtime"]] as const)(
      "rejects case-aliased runtime structure %s",
      async ([relative, alias], { mac }) =>
        withArtifact(mac, async (h) => {
          await rename(h.at(relative), h.at(alias));
          expect(readdirSync(path.dirname(h.at(alias)))).toContain(path.basename(alias));
          await verify(h, "canonical directory spelling required");
        }),
    );

    it.concurrent.for([
      ...(["version", "commit", "builtAt", "buildId"] as const).map((key) =>
        JSON.stringify({ ...buildInfo, [key]: "wrong" }),
      ),
      "{",
      `${JSON.stringify(buildInfo)}\n${JSON.stringify(buildInfo)}`,
    ])("rejects mismatched or noncanonical runtime metadata %s", async (metadata, { mac }) =>
      withArtifact(mac, async (h) => {
        await write(h.at(runtimeMetadata), metadata);
        const result = await verify(h, metadataDiagnostic);
        expect(result.stderr).toContain(runtimeRoot);
      }),
    );

    it.concurrent("rejects nonnative Bun and missing app build identity", async ({ mac }) =>
      withArtifact(mac, async (h) => {
        const bun = h.at(runtimeBun);
        await write(bun, "#!/bin/sh\nexit 97\n", 0o755);
        const nonNative = await h.verify();
        expect(nonNative.status, nonNative.stderr).toBe(1);
        expect(nonNative.stderr).toContain("elevation runtime binary must be Mach-O:");
        await write(bun, h.binaries.universal, 0o755);
        await h.tool("/usr/bin/plutil", [
          "-remove",
          "OpenClawRuntimeBuildID",
          h.at("Contents/Info.plist"),
        ]);
        const missingIdentity = await h.verify("plist-error-stdout");
        expect(missingIdentity.status, missingIdentity.stderr).toBe(1);
        expect(missingIdentity.stderr).toContain("elevation app is missing runtime build identity");
      }));

    it.concurrent.for(["Contents", runtimeBun])(
      "rejects an escaping root, intermediate, or terminal link at %s",
      async (relative, { mac }) =>
        withArtifact(mac, async (h) => {
          const target = h.at(relative);
          const outside = path.join(h.home, "outside-runtime");
          await rename(target, outside);
          await symlink(outside, target);
          await verify(
            h,
            /elevation runtime directory missing or symlinked|elevation runtime symlink escapes its runtime tree/,
          );
        }),
    );

    it.concurrent.for([
      "dangling",
      "terminal-cycle",
      "directory-cycle",
      "indirect-directory-cycle",
      "outside-runtime",
    ])("rejects %s runtime links", async (kind, { mac }) =>
      withArtifact(mac, async (h) => {
        const runtime = h.at(runtimeRoot);
        if (kind === "directory-cycle") {
          await symlink(".", path.join(runtime, "loop"));
        } else if (kind === "indirect-directory-cycle") {
          await mkdir(path.join(runtime, "a"));
          await mkdir(path.join(runtime, "b"));
          await symlink("../b", path.join(runtime, "a/to-b"));
          await symlink("../a", path.join(runtime, "b/to-a"));
        } else if (kind === "outside-runtime") {
          await symlink("../..", path.join(runtime, "outside-runtime"));
        } else {
          const bun = path.join(runtime, "bin/bun");
          await rm(bun);
          await symlink(kind === "dangling" ? "missing" : "bun", bun);
        }
        await verify(
          h,
          kind.endsWith("directory-cycle")
            ? "cyclic or unreadable elevation runtime tree"
            : kind === "outside-runtime"
              ? "elevation runtime symlink escapes its runtime tree"
              : "broken or cyclic elevation runtime symlink",
        );
      }),
    );

    const faultCases: Array<[string, string, number?, string?, string?]> = [
      ["generic-native-arm64", nativeFormat, 1, "spctl --assess --type execute", addon],
      ["missing-native-format-x86_64", nativeFormat, 1, "spctl --assess --type execute", addon],
      ["team-arm64", signatureDiagnostic, 1, archCommand("arm64")],
      ["team-x86_64", signatureDiagnostic, 1, archCommand("x86_64")],
      ["authority-arm64", signatureDiagnostic, 1, archCommand("arm64")],
      ["authority-x86_64", signatureDiagnostic, 1, archCommand("x86_64")],
      [
        "signature",
        signatureDiagnostic,
        1,
        "codesign --verify --deep --strict --all-architectures",
      ],
      [
        "notarized",
        "mock rejection: notarized",
        23,
        "codesign --verify --strict --test-requirement==notarized",
      ],
      ["stapler", "mock rejection: stapler", 23, "xcrun stapler validate"],
      ["spctl", "mock rejection: spctl", 23, "spctl --assess --type execute"],
      ["apple-events", "Apple Events entitlement remains on elevation code:", 1, `/${addon}`],
      ["bundle-events", "Apple Events entitlement remains on elevation bundle:", 1, "/fixture.xpc"],
      [
        "mlx",
        "MLX helper must be signed without app entitlements:",
        1,
        "/Contents/MacOS/openclaw-mlx-tts",
      ],
      ["cdhash-arm64", "artifact receipt arm64 CDHash mismatch", 1, archCommand("arm64")],
      ["cdhash-x86_64", "artifact receipt x86_64 CDHash mismatch", 1, archCommand("x86_64")],
      ["find-code", "could not scan elevation code"],
      ["find-links", "cyclic or unreadable elevation runtime tree"],
      ["file", "could not inspect elevation code:"],
      ["file-empty", "invalid elevation code classification:"],
      ["file-missing-description", "invalid elevation code classification:"],
      ["file-unterminated-description", "invalid elevation code classification:"],
      ["file-empty-description", "invalid elevation code classification:"],
      ["file-mismatched-path", "invalid elevation code classification:"],
      ["file-trailing-byte", "unexpected trailing elevation code classification"],
      ["file-extra-record", "unexpected trailing elevation code classification"],
      ["file-partial-error", "could not inspect elevation code:"],
      ["file-changed-type", "elevation code changed type during classification:"],
      ["lipo", "could not inspect elevation code slices:"],
    ];
    it.concurrent.for(faultCases)(
      "rejects %s verification faults",
      async ([fault, diagnostic, code = 1, command, detail], { mac }) =>
        withArtifact(mac, async (h) => {
          if (command && !detail) {
            await mkdir(h.at(`${runtimeRoot}/fixture.xpc`));
          }
          const result = await verify(h, diagnostic, fault, code);
          if (command) {
            expect(readFileSync(h.calls, "utf8")).toContain(command);
          }
          if (detail) {
            expect(result.stderr).toContain(detail);
          }
        }),
    );

    it.concurrent.for(["file", "symlink"])(
      "preserves CUA omission for a driver %s",
      async (kind, { mac }) =>
        withArtifact(mac, async (h) => {
          const driver = h.at("Contents/Resources/cua-driver");
          if (kind === "file") {
            await write(driver, "inert driver");
          } else {
            await symlink("missing-driver", driver);
          }
          await verify(h, "elevation app must not contain bundled CUA driver:");
        }),
    );
    it.concurrent.for(["healthy", "spctl"])(
      "fully verifies a new destination-stage copy with %s policy",
      async (fault, { mac }) =>
        withArtifact(mac, async (h) => {
          const result = await h.verifyStagedCopy(fault);
          expect(result.status, result.stderr).toBe(fault === "healthy" ? 0 : 23);
          const checks = readFileSync(h.calls, "utf8")
            .split("\n")
            .filter((line) =>
              line.startsWith("codesign --verify --deep --strict --all-architectures "),
            );
          expect(checks).toHaveLength(1);
          expect(checks[0]).toContain(`${h.home}/stage-destination.app.incoming-`);
          expect(
            readdirSync(h.home).filter((name) =>
              name.startsWith("stage-destination.app.incoming-"),
            ),
          ).toEqual([]);
          if (fault === "healthy") {
            expect(result.stdout).toContain("Staged copy verified:");
          } else {
            expect(result.stdout).not.toContain("Staged copy verified:");
          }
        }),
    );

    it.concurrent.for([
      ["sourceCommit", "OpenClaw source"],
      ["peekabooCommit", "Peekaboo source"],
      ["version", "version"],
      ["build", "build"],
      ["authority", "signing authority"],
      ["teamIdentifier", "TeamIdentifier"],
      ["architectures", "main", "main architecture"],
      ["architectures", "helper", "helper architecture"],
      ["entitlementsSha256", "main", "main entitlement"],
      ["entitlementsSha256", "helper", "helper entitlement"],
    ] as const)("binds receipt %s to the fully audited app", async (row, { mac }) =>
      withArtifact(mac, async (h) => {
        if (row.length === 2) {
          h.receipt[row[0]] = "wrong";
        } else {
          h.receipt[row[0]][row[1]] = "wrong";
        }
        const diagnostic = row.length === 2 ? row[1] : row[2];
        await verify(h, `artifact receipt ${diagnostic} mismatch`);
        expect(readFileSync(h.calls, "utf8")).toContain("spctl --assess --type execute");
      }),
    );

    it.concurrent.for(["notarized", "stapler", "spctl"])(
      "propagates %s failure through conditional receipt verification",
      async (fault, { mac }) =>
        withArtifact(mac, async (h) => {
          const result = await h.verifyReceiptConditionally(fault);
          expect(result.status, result.stderr).toBe(23);
          expect(result.stderr).toContain(`mock rejection: ${fault}`);
          expect(result.stdout).not.toContain("Conditional receipt accepted");
        }),
    );

    it.concurrent.for([
      ["healthy", "valid", "spctl --assess --type execute"],
      ["notarized", "damaged", "codesign --verify --strict --test-requirement==notarized"],
      ["stapler", "damaged", "xcrun stapler validate"],
      ["spctl", "damaged", "spctl --assess --type execute"],
    ] as const)(
      "classifies recovery planning after %s policy result",
      async ([fault, state, command], { mac }) =>
        withArtifact(mac, async (h) => {
          const result = await h.recoveryPlan(fault);
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toBe(`Recovery planning state: ${state}\n`);
          const calls = readFileSync(h.calls, "utf8");
          expect(calls).toContain(command);
          expect(calls).toContain("stable-recovery-identity");
        }),
    );
  },
);
