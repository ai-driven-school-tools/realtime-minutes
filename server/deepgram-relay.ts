import { DeepgramClient } from "@deepgram/sdk";
import type { WebSocket } from "ws";
import { getConfig, type Config, type Replacement } from "./config.js";
import { TranscriptWriter } from "./transcript-writer.js";
import type { ServerMessage } from "./types.js";
import { logger } from "./logger.js";

type V1Socket = Awaited<
  ReturnType<InstanceType<typeof DeepgramClient>["listen"]["v1"]["connect"]>
>;

function formatReplacement(r: Replacement): string {
  return `${r.find}:${r.replace}`;
}

export class DeepgramRelay {
  readonly timestamp: string;
  readonly llmInputBuffer: string[] = [];
  readonly outputPath: string;

  private readonly config: Config;
  private readonly writer: TranscriptWriter;
  private readonly meetingStartTime: Date;
  private readonly connectArgs: Parameters<InstanceType<typeof DeepgramClient>["listen"]["v1"]["connect"]>[0];

  private connection: V1Socket | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastDataSentAt = Date.now();
  private timestampOffsetMs = 0;

  private reconnecting = false;
  private readonly audioBuffer: Buffer[] = [];
  private audioBufferBytes = 0;

  constructor(
    private readonly apiKey: string,
    private readonly browserWs: WebSocket,
  ) {
    this.config = getConfig();
    this.meetingStartTime = new Date();
    this.timestamp = this.meetingStartTime
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    this.writer = new TranscriptWriter(this.timestamp);
    this.outputPath = this.writer.getOutputPath();

    this.connectArgs = {
      model: this.config.deepgram.model,
      language: this.config.deepgram.language,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      ...(this.config.deepgram.diarize ? { diarize: "true" } : {}),
      interim_results: String(this.config.deepgram.interimResults),
      endpointing: String(this.config.deepgram.endpointing),
      utterance_end_ms: String(this.config.deepgram.utteranceEndMs),
      smart_format: String(this.config.deepgram.smartFormat),
      punctuate: String(this.config.deepgram.punctuate),
      Authorization: this.apiKey,
      queryParams: this.buildQueryParams(),
    };
  }

  async start(participants: string[]): Promise<void> {
    await this.writer.init(participants);
    this.connection = await this.openConnection();
    this.startKeepAlive();
  }

  sendAudio(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    this.lastDataSentAt = Date.now();

    if (this.reconnecting) {
      this.bufferChunk(chunk);
      return;
    }

    try {
      this.connection?.sendMedia(chunk);
    } catch {
      logger.warn("音声送信失敗 — 再接続を開始");
      this.bufferChunk(chunk);
      void this.reconnect();
    }
  }

  async stop(): Promise<void> {
    this.sendToClient({ type: "stopping" });

    try { this.connection?.sendFinalize({ type: "Finalize" }); } catch {}
    await this.wait(5000);
    try { this.connection?.sendCloseStream({ type: "CloseStream" }); } catch {}

    this.clearKeepAlive();
    await this.writer.flush();

    try { this.connection?.close(); } catch {}
    this.connection = null;
  }

  private buildQueryParams(): Record<string, string[]> | undefined {
    const params: Record<string, string[]> = {};
    const { keyterms, replacements } = this.config.deepgram;

    if (keyterms.length > 0) {
      params.keyterm = keyterms;
      logger.info(`Deepgram keyterms: ${keyterms.join(", ")}`);
    }

    if (replacements.length > 0) {
      params.replace = replacements.map(formatReplacement);
      logger.info(
        `Deepgram replace: ${replacements.map(formatReplacement).join(", ")}`,
      );
    }

    return Object.keys(params).length > 0 ? params : undefined;
  }

  // --- Private: Connection lifecycle ---

  private async openConnection(): Promise<V1Socket> {
    const client = new DeepgramClient({ apiKey: this.apiKey });
    const conn = await client.listen.v1.connect(this.connectArgs);

    conn.on("open", () => {
      logger.info("Deepgram 接続確立");
      if (!this.reconnecting) {
        this.sendToClient({ type: "ready", outputPath: this.outputPath });
      }
    });

    conn.on("message", (data) => this.handleTranscriptMessage(data));

    conn.on("error", (error) => {
      logger.error("Deepgram エラー", error);
      this.sendToClient({ type: "error", code: "DEEPGRAM_ERROR", message: error.message });
    });

    conn.on("close", () => {
      logger.info("Deepgram 接続終了");
    });

    conn.connect();
    await conn.waitForOpen();
    return conn;
  }

  private handleTranscriptMessage(data: { type: string }): void {
    if (data.type !== "Results") return;

    const result = data as unknown as {
      is_final?: boolean;
      speech_final?: boolean;
      start: number;
      channel: { alternatives: { transcript: string; words: { speaker?: number }[] }[] };
    };

    const alt = result.channel.alternatives[0];
    if (!alt) return;

    const { transcript } = alt;
    const isFinal = result.is_final ?? false;
    const speechFinal = result.speech_final ?? false;

    this.sendToClient({ type: "transcript", text: transcript, isFinal });

    if (!isFinal || !transcript.trim()) return;

    const ts = this.formatTimestamp(result.start + this.timestampOffsetMs / 1000);
    this.writer.appendUtterance(transcript, ts, speechFinal);
    this.llmInputBuffer.push(transcript);
  }

  // --- Private: Reconnection ---

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.sendToClient({ type: "reconnecting" });
    this.clearKeepAlive();

    const elapsedMs = Date.now() - this.meetingStartTime.getTime();

    for (let attempt = 1; attempt <= this.config.reconnect.maxAttempts; attempt++) {
      const backoff = Math.pow(2, attempt - 1) * 1000;
      logger.info(`Deepgram 再接続 試行 ${attempt}/${this.config.reconnect.maxAttempts} (${backoff}ms後)`);
      await this.wait(backoff);

      try {
        this.connection = await this.openConnection();
        this.timestampOffsetMs = elapsedMs;
        this.drainAudioBuffer();
        this.startKeepAlive();
        this.reconnecting = false;
        this.sendToClient({ type: "reconnected" });
        logger.info("Deepgram 再接続成功");
        return;
      } catch (e) {
        logger.error(`再接続試行 ${attempt} 失敗`, e);
      }
    }

    this.reconnecting = false;
    this.sendToClient({
      type: "error",
      code: "DEEPGRAM_RECONNECT_FAILED",
      message: `Deepgram への再接続に ${this.config.reconnect.maxAttempts} 回失敗しました`,
    });
  }

  // --- Private: KeepAlive ---

  private startKeepAlive(): void {
    this.clearKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (Date.now() - this.lastDataSentAt > this.config.keepAlive.idleThresholdMs) {
        try { this.connection?.sendKeepAlive({ type: "KeepAlive" }); } catch {
          logger.warn("KeepAlive 送信失敗");
        }
      }
    }, this.config.keepAlive.intervalMs);
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  // --- Private: Audio buffer (reconnection) ---

  private bufferChunk(chunk: Buffer): void {
    while (
      this.audioBufferBytes + chunk.byteLength > this.config.reconnect.maxBufferBytes &&
      this.audioBuffer.length > 0
    ) {
      const dropped = this.audioBuffer.shift()!;
      this.audioBufferBytes -= dropped.byteLength;
      logger.warn("再接続バッファ上限超過: 古いチャンクを破棄");
    }
    this.audioBuffer.push(chunk);
    this.audioBufferBytes += chunk.byteLength;
  }

  private drainAudioBuffer(): void {
    const chunks = this.audioBuffer.splice(0);
    this.audioBufferBytes = 0;
    for (const chunk of chunks) {
      try { this.connection?.sendMedia(chunk); } catch { break; }
    }
  }

  // --- Private: Utilities ---

  private sendToClient(msg: ServerMessage): void {
    if (this.browserWs.readyState === this.browserWs.OPEN) {
      this.browserWs.send(JSON.stringify(msg));
    }
  }

  private formatTimestamp(startSeconds: number): string {
    const d = new Date(this.meetingStartTime.getTime() + startSeconds * 1000);
    return d.toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
