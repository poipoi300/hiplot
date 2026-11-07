const NO_BREAK_SPACE = String.fromCharCode(0xa0);

/** Escapes text for insertion into HTML, as serializing a DOM text node would. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split(NO_BREAK_SPACE)
    .join("&nbsp;");
}

/** Escapes text so it matches literally inside a regular expression. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** The text of a column label given as HTML, or `fallback` when it has none. */
export function labelTextFromHtml(html: string, fallback: string): string {
  const container = document.createElement("div");
  container.innerHTML = html;
  const text = (container.textContent ?? "").trim();
  return text.length ? text : fallback;
}
