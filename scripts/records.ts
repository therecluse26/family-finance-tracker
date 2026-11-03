export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

// Reads a JSON list of records in which every field is a non-empty string.
export function parseRecords<Field extends string>(
  json: unknown,
  file: string,
  fields: readonly Field[],
  dateFields: readonly Field[],
): Record<Field, string>[] {
  if (!Array.isArray(json)) throw new Error(`${file} must hold a JSON list of records.`);
  return json.map((record: unknown, index) => {
    const at = `Record ${index + 1} in ${file}`;
    if (!isRecord(record)) throw new Error(`${at} is not an object.`);
    const parsed = {} as Record<Field, string>;
    for (const field of fields) {
      const value = record[field];
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${at} needs "${field}" as a non-empty string.`);
      }
      if (dateFields.includes(field) && !isIsoDate(value)) {
        throw new Error(`${at} needs "${field}" as a YYYY-MM-DD date, not "${value}".`);
      }
      parsed[field] = value;
    }
    return parsed;
  });
}
