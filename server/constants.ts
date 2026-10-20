// preflight.ts と env.ts の両方から参照される定数。
// 外部ライブラリに依存しないため、preflight.ts を単独実行しても安全。

export const REQUIRED_KEYS = [
  "DEEPGRAM_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
] as const;

export const DEFAULT_PORT = 3001;
