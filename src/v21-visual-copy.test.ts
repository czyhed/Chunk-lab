import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOfficeVisualCopy,
  type OfficeProcessRunner,
  type OfficeProcessSpec,
} from "./v21-visual-copy.js";

const tempDirectory = await mkdtemp(join(tmpdir(), "v21-visual-copy-"));

for (const [extension, expectedConverter] of [
  ["docx", "microsoft-office-com-word"],
  ["pptx", "microsoft-office-com-powerpoint"],
  ["xlsx", "microsoft-office-com-excel"],
] as const) {
  let processSpec: OfficeProcessSpec | undefined;
  const runner: OfficeProcessRunner = async (spec) => {
    processSpec = spec;
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        converter: expectedConverter,
        converterVersion: "16.0",
      }),
      stderr: "",
    };
  };
  const outputPath = join(tempDirectory, `${extension}.pdf`);
  const result = await createOfficeVisualCopy(
    {
      sourcePath: join(tempDirectory, `source.${extension}`),
      outputPath,
    },
    runner,
  );

  assert.deepEqual(result, {
    converter: expectedConverter,
    converterVersion: "16.0",
    outputPath,
  });
  assert.equal(processSpec?.executable, "pwsh.exe");
  assert.equal(processSpec?.environment.V21_OFFICE_SOURCE, join(tempDirectory, `source.${extension}`));
  assert.equal(processSpec?.environment.V21_VISUAL_COPY_TARGET, outputPath);
  assert.match(processSpec?.script ?? "", /finally/);
  assert.match(processSpec?.script ?? "", /\.Quit\(\)/);
}

let unsupportedRunnerCalled = false;
await assert.rejects(
  createOfficeVisualCopy(
    {
      sourcePath: join(tempDirectory, "legacy.doc"),
      outputPath: join(tempDirectory, "legacy.pdf"),
    },
    async () => {
      unsupportedRunnerCalled = true;
      throw new Error("must not run");
    },
  ),
  /Unsupported Office Visual Copy source: \.doc/,
);
assert.equal(unsupportedRunnerCalled, false);

await assert.rejects(
  createOfficeVisualCopy(
    {
      sourcePath: join(tempDirectory, "secret-name.docx"),
      outputPath: join(tempDirectory, "secret-name.pdf"),
    },
    async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "sensitive runtime details [redacted]",
    }),
  ),
  (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Office Visual Copy conversion failed (exit code 1)");
    return true;
  },
);

console.log("V2.1 Office Visual Copy adapter tests passed");
