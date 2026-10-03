import fs from "node:fs";
import path from "node:path";

export class ImageStore {
  constructor(private readonly imageDir: string) {
    fs.mkdirSync(imageDir, { recursive: true });
  }

  getFilePath(imageId: string, mimeType: string) {
    const ext = mimeType === "image/png" ? "png" : "bin";
    return path.join(this.imageDir, `${imageId}.${ext}`);
  }

  write(imageId: string, mimeType: string, bytes: Uint8Array) {
    const filePath = this.getFilePath(imageId, mimeType);
    fs.writeFileSync(filePath, bytes);
    return filePath;
  }

  read(imageId: string, mimeType: string) {
    return fs.readFileSync(this.getFilePath(imageId, mimeType));
  }

  delete(imageId: string, mimeType: string) {
    const filePath = this.getFilePath(imageId, mimeType);
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  }
}
