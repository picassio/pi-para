import { basename } from "node:path";

export const LEGACY_DAEMON_COMMANDS = new Set([
  "daemon",
  "watch",
  "start",
  "stop",
  "legacy-status",
  "process",
  "process-recent",
  "retry-failed",
  "history",
]);

export function isLegacyDaemonCommand(command: string | undefined): boolean {
  return command !== undefined && LEGACY_DAEMON_COMMANDS.has(command);
}

export function isLegacyDaemonBinary(executablePath: string | undefined): boolean {
  if (!executablePath) return false;
  const name = basename(executablePath.replaceAll("\\", "/")).toLowerCase();
  return name === "pi-para-daemon" || name === "pi-para-daemon.cmd" || name === "pi-para-daemon.exe";
}

export function formatLegacyDaemonRemoval(command: string): string {
  return [
    `[pi-para] Legacy daemon command '${command}' was removed in 0.7.`,
    "Capture and maintenance run automatically via the embedded scheduler.",
    "Use 'pi-para tasks' to inspect scheduler work and 'pi-para doctor' for diagnostics.",
  ].join("\n");
}
