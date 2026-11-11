import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import type { ProcessOwner } from "./process-owner.ts";

const powershell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
function argumentsFor(script: string): string[] {
  const encoded = Buffer.from(
    `$ErrorActionPreference = 'Stop'; ${script}`,
    "utf16le",
  ).toString("base64");
  assert(encoded.length < 30000, "Windows process command is too large");
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ];
}

export function windowsIdentity(pid: number): string | null {
  assert(Number.isSafeInteger(pid) && pid > 0, "Invalid process ID");
  try {
    const identity = execFileSync(
      powershell,
      argumentsFor(`
        try { $p = Get-Process -Id ${pid} -ErrorAction Stop }
        catch {
          if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { exit 3 }
          throw
        }
        [Console]::Write($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(
          [Globalization.CultureInfo]::InvariantCulture))
      `),
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    ).trim();
    assert(/^\d+$/.test(identity), "Invalid Windows process creation identity");
    return identity;
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 3)
      return null;
    throw error;
  }
}

// The guardian stays outside the job. Closing its last handle kills the entire
// job even if the group leader or Studio crashes before cleanup can run.
const nativeJob = String.raw`
Add-Type -TypeDefinition @'
#pragma warning disable 0649
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class StrandJob {
  [StructLayout(LayoutKind.Sequential)]
  struct Limits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public Limits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  static void Check(bool success) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  static IntPtr OpenOwner(uint pid, string identity, uint access) {
    IntPtr process = OpenProcess(access | 0x1000, false, pid);
    if (process == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error == 87) return IntPtr.Zero;
      throw new Win32Exception(error);
    }
    try {
      long created, exited, kernel, user;
      Check(GetProcessTimes(process, out created, out exited, out kernel, out user));
      if (created.ToString(System.Globalization.CultureInfo.InvariantCulture) != identity) {
        CloseHandle(process);
        return IntPtr.Zero;
      }
      return process;
    } catch { CloseHandle(process); throw; }
  }
  static IntPtr Open(string name, uint access) {
    IntPtr job = OpenJobObject(access, false, name);
    if (job == IntPtr.Zero && Marshal.GetLastWin32Error() != 2)
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return job;
  }
  static bool Active(IntPtr job) {
    Accounting value;
    Check(QueryInformationJobObject(job, 1, out value,
      (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
    return value.ActiveProcesses != 0;
  }
  public static bool Active(string name) {
    IntPtr job = Open(name, 4);
    if (job == IntPtr.Zero) return false;
    try { return Active(job); } finally { CloseHandle(job); }
  }
  public static void Stop(string name, uint pid, string identity) {
    IntPtr job = Open(name, 8);
    if (job != IntPtr.Zero) {
      try { Check(TerminateJobObject(job, 1)); } finally { CloseHandle(job); }
      return;
    }
    IntPtr process = OpenOwner(pid, identity, 1);
    if (process == IntPtr.Zero) return;
    try { Check(TerminateProcess(process, 1)); } finally { CloseHandle(process); }
  }
  public static void Guard(string name, uint pid, string identity) {
    IntPtr process = OpenOwner(pid, identity, 0x100101);
    if (process == IntPtr.Zero) throw new InvalidOperationException("Agent owner exited before job registration");
    IntPtr job = IntPtr.Zero;
    try {
      job = CreateJobObject(IntPtr.Zero, name);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (Marshal.GetLastWin32Error() == 183)
        throw new InvalidOperationException("Agent job already exists");
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000;
      Check(SetInformationJobObject(job, 9, ref limits,
        (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      Check(AssignProcessToJobObject(job, process));
      Console.WriteLine("ready");
      Console.Out.Flush();
      Check(WaitForSingleObject(process, 0xffffffff) == 0);
      Check(TerminateJobObject(job, 1));
      while (Active(job)) Thread.Sleep(10);
    } finally {
      if (job != IntPtr.Zero) CloseHandle(job);
      CloseHandle(process);
    }
  }
}
'@
`;

function jobName(owner: ProcessOwner): string {
  return `Local\\Strand-${owner.pid}-${createHash("sha256").update(owner.identity).digest("hex")}`;
}

function jobScript(action: "Active" | "Stop" | "Guard", owner: ProcessOwner) {
  assert(
    Number.isSafeInteger(owner.pid) && owner.pid > 0,
    "Invalid process ID",
  );
  return (
    nativeJob +
    (action === "Active"
      ? `[Console]::Write([StrandJob]::Active(${quote(jobName(owner))}))`
      : `[StrandJob]::${action}(${quote(jobName(owner))}, ${owner.pid}, ${quote(owner.identity)})`)
  );
}

export function windowsGroupActive(owner: ProcessOwner): boolean {
  const result = execFileSync(
    powershell,
    argumentsFor(jobScript("Active", owner)),
    { encoding: "utf8", timeout: 15000, windowsHide: true },
  ).trim();
  assert(["True", "False"].includes(result), "Invalid Windows job status");
  return result === "True";
}

export function stopWindowsGroup(owner: ProcessOwner): void {
  execFileSync(powershell, argumentsFor(jobScript("Stop", owner)), {
    timeout: 15000,
    windowsHide: true,
  });
}

export async function registerWindowsGroup(owner: ProcessOwner): Promise<void> {
  const guardian = spawn(powershell, argumentsFor(jobScript("Guard", owner)), {
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      guardian.kill("SIGKILL");
      reject(new Error("Windows job guardian did not become ready"));
    }, 30000);
    let output = "";
    guardian.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.split(/\r?\n/).includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    guardian.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    guardian.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Windows job guardian exited ${code}/${signal ?? ""}; inspect stderr.log`,
        ),
      );
    });
  });
}
