import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { getEnv } from "./env.js";
import { logger } from "./logger.js";

export interface Replacement {
  find: string;
  replace: string;
}

export interface Config {
  server: {
    port: number;
  };
  deepgram: {
    model: string;
    language: string;
    diarize: boolean;
    interimResults: boolean;
    endpointing: number | false;
    utteranceEndMs: number;
    smartFormat: boolean;
    punctuate: boolean;
    keyterms: string[];
    replacements: Replacement[];
  };
  keepAlive: {
    intervalMs: number;
    idleThresholdMs: number;
  };
  taskExtraction: {
    model: string;
    intervalMs: number;
    llmMaxRetries: number;
    maxConsecutiveFailures: number;
    maxBackoffMs: number;
  };
  reconnect: {
    maxAttempts: number;
    maxBufferBytes: number;
  };
  output: {
    dir: string;
  };
  participants: string[];
}

// --- config.yaml 読み込み ---

const CONFIG_YAML_PATH = "config.yaml";

interface MeetingConfig {
  participants: string[];
  keyterms: string[];
  replacements: Replacement[];
}

const DEFAULT_MEETING_CONFIG: MeetingConfig = {
  participants: [],
  keyterms: [],
  replacements: [],
};

function filterStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function isReplacement(v: unknown): v is Replacement {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.find === "string" && typeof r.replace === "string";
}

function loadMeetingConfig(): MeetingConfig {
  if (!fs.existsSync(CONFIG_YAML_PATH)) {
    logger.info("config.yaml が見つかりません。デフォルト設定で起動します");
    return DEFAULT_MEETING_CONFIG;
  }

  try {
    const raw = fs.readFileSync(CONFIG_YAML_PATH, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;

    const config: MeetingConfig = {
      participants: filterStrings(parsed.participants),
      keyterms: filterStrings(parsed.keyterms),
      replacements: Array.isArray(parsed.replacements)
        ? parsed.replacements.filter(isReplacement)
        : [],
    };

    logger.info(
      `config.yaml: 参加者 ${config.participants.length} 名, キーターム ${config.keyterms.length} 件, 置換ルール ${config.replacements.length} 件`,
    );

    return config;
  } catch (e) {
    logger.warn(
      "config.yaml の読み込みに失敗しました。デフォルト設定で起動します",
      e,
    );
    return DEFAULT_MEETING_CONFIG;
  }
}

// プロセスライフタイムで1回だけ初期化される設定値（録音セッション状態とは無関係）
let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    const env = getEnv();
    const meeting = loadMeetingConfig();
    _config = {
      server: {
        port: env.PORT,
      },
      deepgram: {
        model: "nova-3",
        language: "ja",
        diarize: false,
        interimResults: true,
        endpointing: 500,
        utteranceEndMs: 1000,
        smartFormat: true,
        punctuate: true,
        keyterms: [
          ...new Set([...meeting.participants, ...meeting.keyterms]),
        ],
        replacements: meeting.replacements,
      },
      keepAlive: {
        intervalMs: 3_000,
        idleThresholdMs: 5_000,
      },
      taskExtraction: {
        model: "gemini-3-flash-preview",
        intervalMs: 30_000,
        llmMaxRetries: 0,
        maxConsecutiveFailures: 3,
        maxBackoffMs: 180_000,
      },
      reconnect: {
        maxAttempts: 3,
        maxBufferBytes: 2 * 1024 * 1024,
      },
      output: {
        dir: "output",
      },
      participants: meeting.participants,
    };
  }
  return _config;
}
