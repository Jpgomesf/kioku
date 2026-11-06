// Shared plumbing for every command: the Tauri/mock switch and the one error shape.
// Inside Tauri, calls go through invoke(); in a plain browser (npm run dev) they answer
// from the area's mock module, loaded lazily so it never ships in the desktop bundle's
// main chunk.

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** The codes the Rust side returns (see src-tauri/src/error.rs). */
export type CommandErrorCode =
  | "not_implemented"
  | "read_only"
  | "not_found"
  | "invalid_argument"
  | "unavailable";

const CODES: readonly string[] = [
  "not_implemented",
  "read_only",
  "not_found",
  "invalid_argument",
  "unavailable",
];

/** What every failed command rejects with, in Tauri and in the mock alike. */
export interface CommandError {
  code: CommandErrorCode;
  message: string;
}

export function commandError(code: CommandErrorCode, message: string): CommandError {
  return { code, message };
}

export function isCommandError(value: unknown): value is CommandError {
  if (typeof value !== "object" || value === null) return false;
  const { code, message } = value as { code?: unknown; message?: unknown };
  return typeof code === "string" && CODES.includes(code) && typeof message === "string";
}

/** Normalize any rejection (a CommandError, an Error, a string) into a CommandError. */
export function toCommandError(error: unknown): CommandError {
  if (isCommandError(error)) return error;
  if (error instanceof Error) return commandError("unavailable", error.message);
  if (typeof error === "string") return commandError("unavailable", error);
  return commandError("unavailable", "Something went wrong.");
}

export const READ_ONLY_MESSAGE = "Changes are read-only in this build.";

export function isTauri(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

/** Invoke a Tauri command, or answer from the mock outside Tauri. Rejects with a CommandError. */
export async function call<T>(
  command: string,
  args: Record<string, unknown>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  try {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<T>(command, args);
    }
    return await fallback();
  } catch (error) {
    throw toCommandError(error);
  }
}
