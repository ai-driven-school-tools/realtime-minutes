import http from "node:http";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { DeepgramClient } from "@deepgram/sdk";
import { getEnv, EnvError } from "./env.js";
import { logger } from "./logger.js";
import { getConfig } from "./config.js";
import { DeepgramRelay } from "./deepgram-relay.js";
import { taskExtractionLoop } from "./task-extractor.js";
import type { ClientMessage, ServerMessage, TaskStatus } from "./types.js";

async function validateDeepgramKey(apiKey: string): Promise<void> {
  try {
    const client = new DeepgramClient({ apiKey });
    await client.manage.v1.projects.list();
    logger.info("Deepgram: OK");
  } catch (e) {
    if (hasHttpStatus(e, 401, 403)) {
      logger.error("Deepgram: APIキーが無効です。.env を確認してください");
      process.exit(1);
    }
    logger.warn("Deepgram: 検証リクエストに失敗しました（起動は続行）", e);
  }
}

async function validateGoogleAiKey(apiKey: string): Promise<void> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=1`;
  try {
    const res = await fetch(url);
    if (res.status === 401 || res.status === 403) {
      logger.error("Google AI: APIキーが無効です。.env を確認してください");
      process.exit(1);
    }
    if (!res.ok) {
      logger.warn(`Google AI: 検証リクエストが ${res.status} を返しました（起動は続行）`);
      return;
    }
    logger.info("Google AI: OK");
  } catch (e) {
    logger.warn("Google AI: 検証リクエストに失敗しました（起動は続行）", e);
  }
}

function hasHttpStatus(e: unknown, ...codes: number[]): boolean {
  if (!(e instanceof Error)) return false;
  const record = e as Record<string, unknown>;
  const status = record["statusCode"] ?? record["status"];
  if (typeof status === "number") return codes.includes(status);
  const msg = e.message.toLowerCase();
  return codes.some(
    (code) => msg.includes(String(code)) || msg.includes(HTTP_STATUS_NAMES[code] ?? ""),
  );
}

const HTTP_STATUS_NAMES: Record<number, string> = {
  401: "unauthorized",
  403: "forbidden",
};

function sendToWs(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function tryParseClientMessage(text: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.type === "stop") return { type: "stop" };
    return null;
  } catch {
    return null;
  }
}

async function main() {
  const env = getEnv();
  const config = getConfig();

  const participants = config.participants;
  logger.info(`参加者: ${participants.length > 0 ? participants.join(", ") : "(未指定)"}`);

  await validateDeepgramKey(env.DEEPGRAM_API_KEY);
  await validateGoogleAiKey(env.GOOGLE_GENERATIVE_AI_API_KEY);

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    void handleSession(ws, env.DEEPGRAM_API_KEY, participants);
  });

  const port = config.server.port;
  server.listen(port, () => {
    logger.info(`サーバー起動: http://localhost:${port}`);
  });
}

async function handleSession(
  ws: WebSocket,
  apiKey: string,
  participants: string[],
): Promise<void> {
  logger.info("ブラウザ WebSocket 接続");

  const config = getConfig();
  const relay = new DeepgramRelay(apiKey, ws);

  let stopping = false;
  let lastTaskStatus: TaskStatus = { taskCount: 0, failing: false };
  let taskAbortController: AbortController | null = null;
  let taskExtractionPromise: Promise<TaskStatus> | null = null;

  try {
    await relay.start(participants);
  } catch (e) {
    logger.error("Deepgram リレー起動失敗", e);
    sendToWs(ws, {
      type: "error",
      code: "DEEPGRAM_CONNECT_FAILED",
      message: "Deepgram への接続に失敗しました",
    });
    ws.close();
    return;
  }

  taskAbortController = new AbortController();
  taskExtractionPromise = taskExtractionLoop(
    {
      participants,
      outputDir: config.output.dir,
      timestamp: relay.timestamp,
      llmInputBuffer: relay.llmInputBuffer,
      onStatusChange: (status) => {
        lastTaskStatus = status;
        sendToWs(ws, { type: "task_status", ...status });
      },
    },
    taskAbortController.signal,
  );

  async function gracefulStop(): Promise<void> {
    await relay.stop();

    sendToWs(ws, { type: "stopped", ...lastTaskStatus });
    ws.close();

    taskAbortController?.abort();
    if (taskExtractionPromise) {
      const result = await taskExtractionPromise.catch((): null => null);
      if (result && result.taskCount > 0) {
        logger.info(`タスク抽出完了: ${result.taskCount} 件`);
      }
    }
  }

  ws.on("message", (data: Buffer | string, isBinary: boolean) => {
    if (isBinary) {
      relay.sendAudio(data as Buffer);
      return;
    }

    const msg = tryParseClientMessage(String(data));
    if (msg?.type === "stop" && !stopping) {
      stopping = true;
      logger.info("停止要求を受信");
      void gracefulStop();
    }
  });

  ws.on("close", () => {
    logger.info("ブラウザ WebSocket 切断");
    if (!stopping) {
      taskAbortController?.abort();
      taskExtractionPromise?.catch(() => {});
      void relay.stop().catch(() => {});
    }
  });
}

main().catch((e) => {
  if (e instanceof EnvError) {
    console.error(e.message);
  } else {
    logger.error("起動エラー", e);
  }
  process.exit(1);
});
