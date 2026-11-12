/** Copy in secure browser contexts and in offline or embedded pages. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Embedded pages may deny clipboard permission while still allowing the copy command.
    }
  }
  const focused = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    if (typeof document.execCommand !== "function" || !document.execCommand("copy")) {
      throw new Error("The browser could not copy the message");
    }
  } finally {
    input.remove();
    if (focused instanceof HTMLElement) {
      focused.focus({ preventScroll: true });
    }
  }
}
