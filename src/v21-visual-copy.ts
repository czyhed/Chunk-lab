import { spawn } from "node:child_process";
import { extname, resolve } from "node:path";

export type OfficeVisualCopyRequest = {
  sourcePath: string;
  outputPath: string;
};

export type OfficeVisualCopyResult = {
  converter: string;
  converterVersion: string;
  outputPath: string;
};

export type OfficeProcessSpec = {
  executable: "pwsh.exe";
  script: string;
  environment: Record<string, string>;
};

export type OfficeProcessRunner = (
  spec: OfficeProcessSpec,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const converterByExtension = {
  ".docx": "microsoft-office-com-word",
  ".pptx": "microsoft-office-com-powerpoint",
  ".xlsx": "microsoft-office-com-excel",
} as const;

export async function createOfficeVisualCopy(
  request: OfficeVisualCopyRequest,
  runner: OfficeProcessRunner = runPowerShell,
): Promise<OfficeVisualCopyResult> {
  const extension = extname(request.sourcePath).toLowerCase();
  const expectedConverter = converterByExtension[
    extension as keyof typeof converterByExtension
  ];
  if (!expectedConverter)
    throw new Error(`Unsupported Office Visual Copy source: ${extension || "no extension"}`);
  if (extname(request.outputPath).toLowerCase() !== ".pdf")
    throw new Error("Office Visual Copy target must be a PDF");

  let processResult: Awaited<ReturnType<OfficeProcessRunner>>;
  try {
    processResult = await runner({
      executable: "pwsh.exe",
      script: officeConversionScript,
      environment: {
        V21_OFFICE_SOURCE: resolve(request.sourcePath),
        V21_VISUAL_COPY_TARGET: resolve(request.outputPath),
      },
    });
  } catch {
    throw new Error("Office Visual Copy converter could not be started");
  }
  if (processResult.exitCode !== 0)
    throw new Error(
      `Office Visual Copy conversion failed (exit code ${processResult.exitCode})`,
    );

  try {
    const metadata = JSON.parse(processResult.stdout.trim()) as {
      converter?: unknown;
      converterVersion?: unknown;
    };
    if (
      metadata.converter !== expectedConverter ||
      typeof metadata.converterVersion !== "string" ||
      metadata.converterVersion.length === 0
    )
      throw new Error("invalid metadata");
    return {
      converter: expectedConverter,
      converterVersion: metadata.converterVersion,
      outputPath: resolve(request.outputPath),
    };
  } catch {
    throw new Error("Office Visual Copy converter returned invalid metadata");
  }
}

const officeConversionScript = String.raw`
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($env:V21_OFFICE_SOURCE)
$target = [IO.Path]::GetFullPath($env:V21_VISUAL_COPY_TARGET)
$extension = [IO.Path]::GetExtension($source).ToLowerInvariant()
$app = $null
$document = $null
$result = $null
try {
  switch ($extension) {
    '.docx' {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $document = $app.Documents.Open($source, $false, $true)
      $document.ExportAsFixedFormat($target, 17)
      $result = @{ converter = 'microsoft-office-com-word'; converterVersion = [string]$app.Version }
    }
    '.pptx' {
      $app = New-Object -ComObject PowerPoint.Application
      $document = $app.Presentations.Open($source, $true, $true, $false)
      $document.SaveAs($target, 32)
      $result = @{ converter = 'microsoft-office-com-powerpoint'; converterVersion = [string]$app.Version }
    }
    '.xlsx' {
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $document = $app.Workbooks.Open($source, 0, $true)
      $document.ExportAsFixedFormat(0, $target)
      $result = @{ converter = 'microsoft-office-com-excel'; converterVersion = [string]$app.Version }
    }
    default { throw 'Unsupported Office Visual Copy source' }
  }
} finally {
  if ($null -ne $document) {
    try {
      if ($extension -eq '.pptx') { $document.Close() } else { $document.Close($false) }
    } catch {}
    try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) } catch {}
  }
  if ($null -ne $app) {
    try { $app.Quit() } catch {}
    try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) } catch {}
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
$result | ConvertTo-Json -Compress
`;

function runPowerShell(spec: OfficeProcessSpec): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      spec.executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", spec.script],
      {
        env: { ...process.env, ...spec.environment },
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolveResult({ exitCode: exitCode ?? -1, stdout, stderr }),
    );
  });
}
