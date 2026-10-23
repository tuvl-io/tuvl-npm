const isBlob = (value: unknown): value is Blob => typeof Blob !== "undefined" && value instanceof Blob;

/**
 * A multipart body for `input` when any value is a `File`/`Blob` (or an array of them), else
 * `undefined`. Every other value is sent as text; objects and arrays as JSON text, which the
 * server parses by the input's declared type.
 */
export function toFormData(input: unknown): FormData | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const entries = Object.entries(input as Record<string, unknown>);
  const hasFile = entries.some(([, v]) => isBlob(v) || (Array.isArray(v) && v.some(isBlob)));
  if (!hasFile) return undefined;
  const form = new FormData();
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.some(isBlob)) {
      for (const item of value) form.append(name, item as Blob, (item as File).name ?? "file");
    } else if (isBlob(value)) {
      form.append(name, value, (value as File).name ?? "file");
    } else {
      form.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  }
  return form;
}
