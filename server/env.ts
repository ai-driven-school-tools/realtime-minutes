import { config as dotenvConfig } from "dotenv";
import { z } from "zod";
import { REQUIRED_KEYS } from "./constants.js";

const envSchema = z.object({
  DEEPGRAM_API_KEY: z.string().min(1),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1),
  PORT: z
    .string()
    .default("3001")
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

// プロセスライフタイムで1回だけ初期化される設定値（録音セッション状態とは無関係）
let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) _env = loadEnv();
  return _env;
}

function loadEnv(): Env {
  dotenvConfig();

  const result = envSchema.safeParse(process.env);
  if (result.success) return result.data;

  const { fieldErrors } = z.flattenError(result.error);
  throw new EnvError(formatDiagnostics(fieldErrors));
}

function formatDiagnostics(
  fieldErrors: Record<string, string[] | undefined>,
): string {
  const issues = Object.keys(fieldErrors)
    .map((key) => {
      const val = process.env[key];
      const status =
        val === undefined ? "未設定" : val === "" ? "空です" : "値が不正です";
      return `    ${key}: ${status}`;
    })
    .join("\n");

  return [
    "",
    "============================================================",
    "  環境変数が設定されていません",
    "============================================================",
    "",
    "  不足している変数:",
    issues,
    "",
    "  -- 解決方法 -----------------------------------------------",
    "",
    "  .env ファイルがなければ cp .env.example .env で作成し、次の値を設定してください",
    "",
    ...REQUIRED_KEYS.map((key) => `    ${key}=your-key-here`),
    "",
    "    API キーの取得先:",
    "      Deepgram  : https://console.deepgram.com/",
    "      Google AI : https://aistudio.google.com/apikey",
    "",
    "============================================================",
    "",
  ].join("\n");
}
