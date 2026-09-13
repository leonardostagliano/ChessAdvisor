/**
 * Structured IPC errors.
 *
 * Electron keeps only `name`, `message` and `stack` when an `ipcMain.handle` rejection crosses
 * to the renderer: every extra property set on the Error in the main process is dropped on the
 * way. So the machine-readable part of an error (the code, and any payload such as the model
 * suggested by `MODEL_UNAVAILABLE`) travels inside the message, behind a sentinel, and this
 * module is the single place that knows the encoding — no caller has to read the prose.
 */

/** Separates the human-readable text from the JSON payload; deliberately unlikely in prose. */
export const IPC_ERROR_DATA_MARK = ' [[ipcdata]]'

export interface IpcErrorInfo {
  code: string
  /** The message the main process wrote, without the wrappers Electron and `handle()` add. */
  message: string
  /** Empty when the error carried no structured payload. */
  data: Record<string, unknown>
}

/** `Error invoking remote method 'game:resume': …`, added by Electron on the renderer side. */
const REMOTE_PREFIX = /^Error invoking remote method '[^']*':\s*/
/** `IpcError: …` / `GameError: …`, added when Electron re-creates the Error from its name. */
const NAME_PREFIX = /^[A-Za-z]*Error:\s*/
/** `MODEL_UNAVAILABLE: …`, written by `IpcError` itself. */
const CODE_PREFIX = /^([A-Z][A-Z0-9_]*):\s*/

export function isErrorData(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The structured payload an Error carries in-process, if any. */
export function errorData(error: unknown): Record<string, unknown> | undefined {
  const data = (error as { data?: unknown } | null)?.data
  return isErrorData(data) ? data : undefined
}

/** The message an `IpcError` is built with: `code: text`, plus the payload when there is one. */
export function encodeIpcErrorMessage(
  code: string,
  message: string,
  data?: Record<string, unknown>
): string {
  const head = `${code}: ${message}`
  if (!data || Object.keys(data).length === 0) return head
  return `${head}${IPC_ERROR_DATA_MARK}${JSON.stringify(data)}`
}

/**
 * Reads back a rejection, whether it arrived over IPC or was thrown in-process (tests, and the
 * main process itself), so both sides see the same `{ code, message, data }`.
 */
export function parseIpcError(error: unknown): IpcErrorInfo {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const mark = raw.lastIndexOf(IPC_ERROR_DATA_MARK)
  const text = mark >= 0 ? raw.slice(0, mark) : raw
  const encoded = mark >= 0 ? raw.slice(mark + IPC_ERROR_DATA_MARK.length) : ''

  const body = text.replace(REMOTE_PREFIX, '').replace(NAME_PREFIX, '')
  const codeMatch = CODE_PREFIX.exec(body)
  const declared = (error as { code?: unknown } | null)?.code
  const code =
    typeof declared === 'string' && declared.length > 0
      ? declared
      : (codeMatch?.[1] ?? 'E_UNEXPECTED')
  const message = (codeMatch ? body.slice(codeMatch[0].length) : body).trim()

  return { code, message, data: decode(encoded) ?? errorData(error) ?? {} }
}

function decode(encoded: string): Record<string, unknown> | undefined {
  if (encoded.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(encoded)
    return isErrorData(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}
