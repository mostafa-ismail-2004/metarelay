import { ZodError } from "zod";
import { MemoryConflictError } from "../memory/store.js";
import { SkillConflictError } from "../skills/store.js";

/**
 * Translates Node, parseArgs, Zod, filesystem, and domain errors into crisp,
 * actionable single-line CLI messages (never raw stack traces).
 */
export function formatCliError(err: unknown): string {
  if (err instanceof MemoryConflictError || err instanceof SkillConflictError) {
    return err.message;
  }

  if (err instanceof ZodError) {
    const details = err.issues
      .map((issue) => {
        const field = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${field}${issue.message}`;
      })
      .join("; ");
    return `Validation failed: ${details}`;
  }

  if (err && typeof err === "object") {
    const e = err as NodeJS.ErrnoException & { code?: string; message?: string; path?: string };

    if (e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      return `${e.message ?? "Unknown option"}. Run "metarelay --help" for usage.`;
    }
    if (e.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      return `${e.message ?? "Invalid option value"}. Run "metarelay --help" for usage.`;
    }
    if (e.code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") {
      return `${e.message ?? "Unexpected argument"}. Run "metarelay --help" for usage.`;
    }
    if (e.code === "EADDRINUSE") {
      return `Port is already in use. MetaRelay may already be running — check "metarelay status" or pass --port <port>.`;
    }
    if (e.code === "ENOENT") {
      return e.path ? `File or directory not found: ${e.path}` : "File or directory not found.";
    }
    if (e.code === "EACCES" || e.code === "EPERM") {
      return e.path
        ? `Permission denied accessing ${e.path}`
        : "Permission denied.";
    }
    if (typeof e.message === "string" && e.message.trim()) {
      return e.message;
    }
  }

  return String(err);
}
