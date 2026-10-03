/** Base64 of a browser File via FileReader (data-URL payload). Shared by the
 * Claude/Kimi and Codex composers so both read a drop the same way; a held
 * `FileReader.prototype.readAsDataURL` is how the browser suites freeze the
 * local read to prove the Send guard. */
export function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",").at(-1) || "");
    reader.onabort = () => reject(new Error("File reading was cancelled"));
    reader.onerror = () => reject(reader.error || new Error("Unable to read file"));
    reader.readAsDataURL(file);
  });
}
