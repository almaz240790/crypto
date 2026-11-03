/** Сохранить data URL файлом (снимок графика — handle.snapshot, план 3.17). */
export function download(dataUrl: string, name: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = name;
  a.click();
}
