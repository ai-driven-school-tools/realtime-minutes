import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { generateObject, APICallError } from "ai";
import { google } from "@ai-sdk/google";
import { getConfig } from "./config.js";
import { TaskExtractionResultSchema, type ExtractedTask } from "./schemas.js";
import type { TaskStatus } from "./types.js";
import { logger } from "./logger.js";

export interface TaskExtractorOptions {
  participants: string[];
  outputDir: string;
  timestamp: string;
  llmInputBuffer: string[];
  onStatusChange: (status: TaskStatus) => void;
}

type TaskWithId = ExtractedTask & { id: string };

function isQuotaOrRateLimitError(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  if (error.statusCode === 429) return true;
  if (error.statusCode === 503) {
    const body = error.responseBody ?? "";
    return body.includes("RESOURCE_EXHAUSTED") || body.includes("quota");
  }
  return false;
}

function buildPrompt(participants: string[], transcriptText: string): string {
  const participantLine = participants.length > 0
    ? `参加者は ${participants.join("、")} です。`
    : "参加者リストは未提供です。assignee は常に null にしてください。";

  const assigneeRule = participants.length > 0
    ? `- assignee は参加者リスト（${participants.join("、")}）の中からのみ選ぶ。リストにない名前を担当者にしてはならない
- 会話中で「〇〇さんお願い」「〇〇がやります」のように名前が明示されている場合のみ assignee を設定する
- 名前が明示されていない場合は assignee を null にする（推測しない）`
    : "- assignee は常に null にする";

  return `以下は会議の文字起こしの一部です。${participantLine}
話者の区別はありません（すべての発話が話者ラベルなしで記録されています）。

---
${transcriptText}
---

上記の会話から以下を抽出してください。

タスク:
- 誰かが何かをやると約束した、または依頼された内容を抽出する
- 「検討します」「考えておきます」などの曖昧な表現もタスクとして抽出する
- 明確な行動（「作る」「送る」「確認する」「レビューする」等）だけでなく、検討・調査系の意思表示も含める
- evidence には、そのタスクの根拠となる発話を原文のまま引用する

担当者の推定ルール:
${assigneeRule}
- 期限の言及がない場合は deadline を null にする

エッジケース:
- テキストが2文以下の場合は tasks を空配列で返す
- タスクが見当たらない場合は tasks を空配列で返す（無理に抽出しない）`;
}

function formatTasksMarkdown(tasks: TaskWithId[]): string {
  const rows = tasks.map(
    (t) =>
      `| ${t.id} | ${t.summary} | ${t.assignee ?? "-"} | ${t.deadline ?? "-"} | ${t.evidence} |`,
  );

  return [
    "# 抽出タスク",
    "",
    "| # | タスク | 担当 | 期限 | 根拠 |",
    "|---|--------|------|------|------|",
    ...rows,
    "",
    "---",
    `*最終更新: ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}*`,
    "",
  ].join("\n");
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // AbortError on cancellation — expected
  }
}

export async function taskExtractionLoop(
  options: TaskExtractorOptions,
  signal: AbortSignal,
): Promise<TaskStatus> {
  const { participants, outputDir, timestamp, llmInputBuffer, onStatusChange } = options;
  const cfg = getConfig().taskExtraction;
  const tasksFilePath = path.join(outputDir, `meeting-${timestamp}-tasks.md`);
  const allTasks: TaskWithId[] = [];
  let taskCounter = 0;
  let consecutiveFailures = 0;

  function computeBackoffMs(): number {
    if (consecutiveFailures === 0) return cfg.intervalMs;
    return Math.min(
      cfg.intervalMs * Math.pow(2, consecutiveFailures - 1),
      cfg.maxBackoffMs,
    );
  }

  async function extractAndWrite(lines: string[]): Promise<void> {
    const transcriptText = lines.join("\n");
    logger.info(`タスク抽出開始 (${lines.length} 行, ${transcriptText.length} 文字)`);

    const { object } = await generateObject({
      model: google(cfg.model),
      schema: TaskExtractionResultSchema,
      prompt: buildPrompt(participants, transcriptText),
      maxRetries: cfg.llmMaxRetries,
      abortSignal: signal,
    });

    if (object.tasks.length > 0) {
      const newTasks = object.tasks.map((t) => ({
        ...t,
        id: String(++taskCounter),
      }));
      allTasks.push(...newTasks);
      await fs.writeFile(tasksFilePath, formatTasksMarkdown(allTasks), "utf-8");
      logger.info(`タスク ${newTasks.length} 件抽出 → ${tasksFilePath}`);
    } else {
      logger.info("タスクなし（今回のサイクル）");
    }
  }

  function currentStatus(overrides?: Partial<TaskStatus>): TaskStatus {
    return {
      taskCount: allTasks.length,
      failing: consecutiveFailures > 0,
      ...overrides,
    };
  }

  while (!signal.aborted) {
    if (llmInputBuffer.length > 0) {
      const snapshot = llmInputBuffer.splice(0);
      try {
        await extractAndWrite(snapshot);
        consecutiveFailures = 0;
        onStatusChange(currentStatus());
      } catch (e) {
        consecutiveFailures++;
        const isQuota = isQuotaOrRateLimitError(e);

        if (isQuota) {
          logger.warn(
            `タスク抽出失敗: API クォータ超過 (連続 ${consecutiveFailures} 回)。Google AI Studio でプランを確認してください`,
          );
        } else {
          logger.error(`タスク抽出失敗 (連続 ${consecutiveFailures} 回)`, e);
        }

        logger.warn(`失敗した ${snapshot.length} 行を破棄（次サイクルの新規バッファで再試行）`);

        const message = isQuota
          ? "タスク抽出が API 制限で停止中"
          : "タスク抽出でエラーが発生中";
        onStatusChange(currentStatus({ message }));
      }
    }

    await abortableSleep(computeBackoffMs(), signal);
  }

  if (llmInputBuffer.length > 0 && consecutiveFailures < cfg.maxConsecutiveFailures) {
    try {
      logger.info("最終 flush: タスク抽出");
      await extractAndWrite(llmInputBuffer.splice(0));
    } catch {
      logger.warn("最終 flush 失敗");
    }
  } else if (llmInputBuffer.length > 0) {
    logger.warn(
      `最終 flush スキップ: API が ${consecutiveFailures} 回連続で失敗中のため`,
    );
  }

  return currentStatus();
}
