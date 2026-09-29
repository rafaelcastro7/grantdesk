/**
 * CSV for spreadsheets a client will open.
 *
 * A cell starting with "=", "+", "-", "@", tab or carriage return runs as a
 * formula in Excel and Sheets — and funder titles and rule details are text we
 * scraped, not text we wrote. A leading apostrophe keeps such a cell literal.
 */
export function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

/** Browser only: hands the text to the viewer as a file. */
export function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
