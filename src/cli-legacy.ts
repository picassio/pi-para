export const LEGACY_DAEMON_COMMANDS = new Set([
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

export function formatLegacyDaemonWarning(command: string): string {
  const replacement = replacementForLegacyCommand(command);
  return [
    `[pi-para] Warning: '${command}' is a deprecated legacy daemon command.`,
    "pi-para now uses an in-process scheduler while Pi is open; no system daemon is required.",
    replacement ? `Use ${replacement} for the current workflow.` : "Use 'pi-para tasks' or '/wiki-scheduler status' for the current workflow.",
  ].join("\n");
}

function replacementForLegacyCommand(command: string): string | null {
  switch (command) {
    case "start":
      return "'pi-para setup' and restart Pi";
    case "stop":
      return "'/wiki-scheduler status' or close/restart Pi sessions";
    case "legacy-status":
      return "'pi-para tasks' or '/wiki-scheduler status'";
    case "process":
      return "'pi-para capture-recent --hours N' or '/wiki-capture'";
    case "process-recent":
      return "'pi-para capture-recent --hours N'";
    case "retry-failed":
      return "'pi-para tasks retry'";
    case "history":
      return "'pi-para tasks history'";
    default:
      return null;
  }
}
