import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config.js";

export class TranscriptWriter {
  private writeQueue = Promise.resolve();
  private readonly filePath: string;

  constructor(timestamp: string) {
    this.filePath = path.join(
      getConfig().output.dir,
      `meeting-${timestamp}-transcript.md`,
    );
  }

  async init(participants: string[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    const now = new Date();
    const dateStr = now.toLocaleDateString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const timeStr = now.toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const header = [
      `# 会議メモ ${dateStr} ${timeStr}`,
      "",
      "## 参加者",
      participants.length > 0 ? participants.join("、") : "(未指定)",
      "",
      "---",
      "",
    ].join("\n");

    await fs.writeFile(this.filePath, header, "utf-8");
  }

  appendUtterance(
    text: string,
    timestamp: string,
    isSpeechFinal: boolean,
  ): void {
    if (!text.trim()) return;

    let content = `**[${timestamp}]** ${text}\n`;
    if (isSpeechFinal) {
      content += "\n";
    }

    this.append(content);
  }

  private append(text: string): void {
    this.writeQueue = this.writeQueue.then(() =>
      fs.appendFile(this.filePath, text, "utf-8"),
    );
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  getOutputPath(): string {
    return this.filePath;
  }
}
