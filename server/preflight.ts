import { config as dotenvConfig } from "dotenv";
import fs from "node:fs";
import net from "node:net";
import { REQUIRED_KEYS, DEFAULT_PORT } from "./constants.js";

const MIN_NODE_VERSION = 20;

function fail(label: string, ...lines: string[]): never {
  console.error(`\n[check] ${label} ... NG\n`);
  for (const line of lines) console.error(line);
  console.error();
  process.exit(1);
}

function checkNodeVersion(): void {
  const major = parseInt(process.versions.node.split(".")[0]!, 10);
  if (major < MIN_NODE_VERSION) {
    fail(
      `Node.js v${process.versions.node}`,
      `  Node.js v${MIN_NODE_VERSION} 以上が必要です（現在 v${process.versions.node}）。`,
      "  https://nodejs.org/ から最新版をインストールしてください。",
    );
  }
}

function checkEnvFile(): void {
  if (!fs.existsSync(".env")) {
    fail(
      ".env",
      "  .env ファイルが見つかりません。",
      "  以下の手順で作成してください:",
      "",
      "  1. cp .env.example .env",
      '  2. テキストエディタで .env を開く（例: code .env）',
      "  3. API キーを貼り付ける",
      "",
      "  API キーの取得先:",
      "    Deepgram  : https://console.deepgram.com/",
      "    Google AI : https://aistudio.google.com/apikey",
    );
  }
}

function checkRequiredKeys(): void {
  for (const key of REQUIRED_KEYS) {
    const val = process.env[key];
    if (!val || val.trim() === "") {
      fail(
        key,
        `  ${key} が設定されていません。`,
        "  .env ファイルを開いて値を設定してください。",
        "",
        "  API キーの取得先:",
        "    Deepgram  : https://console.deepgram.com/",
        "    Google AI : https://aistudio.google.com/apikey",
      );
    }
  }
}

function resolvePort(): number {
  const portStr = process.env["PORT"] ?? String(DEFAULT_PORT);
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    fail("PORT", `  PORT の値が不正です: ${portStr}`);
  }
  return port;
}

function checkPortAvailable(port: number): Promise<void> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        fail(
          `ポート ${port}`,
          `  ポート ${port} が使用中です。`,
          "  前回のサーバーが残っている場合: just stop を実行",
          "  他のアプリが使用中の場合: そのアプリを終了してください",
        );
      } else if (err.code === "EACCES") {
        fail(
          `ポート ${port}`,
          `  ポート ${port} にアクセス権がありません。`,
          "  1024 以上のポート番号を .env の PORT に設定してください。",
        );
      } else {
        fail(`ポート ${port}`, `  ポートチェックでエラーが発生しました: ${err.message}`);
      }
    });
    server.listen({ port, host: "0.0.0.0" }, () => {
      server.close(() => resolve());
    });
  });
}

async function main(): Promise<void> {
  checkNodeVersion();
  checkEnvFile();
  dotenvConfig();
  checkRequiredKeys();

  const port = resolvePort();
  await checkPortAvailable(port);

  console.log(
    `[check] 環境チェック完了 (Node.js v${process.versions.node}, .env, APIキー, ポート${port})`,
  );
}

main().catch((e) => {
  console.error("プリフライトチェックで予期しないエラーが発生しました:", e);
  process.exit(1);
});
