import { Mic, Square, RotateCcw, CheckCircle, AlertTriangle } from "lucide-react";
import { useRecorder, type RecorderState, type CompletionNotice } from "../hooks/use-recorder";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";

export function RecordingPanel() {
  const { state, start, stop, retry, completionNotice } = useRecorder();

  return (
    <div className="w-full max-w-lg mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">リアルタイム議事録</h1>
        <StatusBadge status={state.status} />
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        <ActionButton state={state} onStart={start} onStop={stop} onRetry={retry} />
        <SnippetArea state={state} />
      </div>

      {state.status === "recording" && (
        <p className="text-xs text-muted-foreground">
          出力先: {state.outputPath}
        </p>
      )}

      {state.status === "error" && (
        <p className="text-xs text-muted-foreground">
          録音済みの内容は保存されています
        </p>
      )}

      {completionNotice && state.status === "idle" && (
        <CompletionBanner notice={completionNotice} />
      )}
    </div>
  );
}

const BADGE_CONFIG: Record<RecorderState["status"], { variant: "secondary" | "warning" | "success" | "destructive"; label: string; pulse?: boolean }> = {
  idle: { variant: "secondary", label: "待機中" },
  connecting: { variant: "warning", label: "接続中" },
  recording: { variant: "success", label: "録音中" },
  reconnecting: { variant: "warning", label: "再接続中", pulse: true },
  stopping: { variant: "secondary", label: "停止処理中" },
  error: { variant: "destructive", label: "エラー" },
};

function StatusBadge({ status }: { status: RecorderState["status"] }) {
  const cfg = BADGE_CONFIG[status];
  return (
    <Badge variant={cfg.variant} className={cfg.pulse ? "animate-pulse" : undefined}>
      {cfg.label}
    </Badge>
  );
}

function ActionButton({
  state,
  onStart,
  onStop,
  onRetry,
}: {
  state: RecorderState;
  onStart: () => void;
  onStop: () => void;
  onRetry: () => void;
}) {
  switch (state.status) {
    case "idle":
      return (
        <Button onClick={onStart} className="w-full">
          <Mic className="h-4 w-4" />
          録音を開始
        </Button>
      );
    case "connecting":
    case "stopping":
      return (
        <Button disabled className="w-full" variant="secondary">
          {state.status === "connecting" ? "接続中..." : "停止処理中..."}
        </Button>
      );
    case "recording":
    case "reconnecting":
      return (
        <Button onClick={onStop} className="w-full" variant="destructive">
          <Square className="h-4 w-4" />
          録音を停止
        </Button>
      );
    case "error":
      return (
        <Button onClick={onRetry} className="w-full">
          <RotateCcw className="h-4 w-4" />
          再試行
        </Button>
      );
  }
}

function SnippetArea({ state }: { state: RecorderState }) {
  switch (state.status) {
    case "idle":
      return null;
    case "connecting":
      return <p className="text-sm text-muted-foreground">接続しています...</p>;
    case "recording":
      return (
        <div className="space-y-2">
          <p className="text-sm text-foreground/80 min-h-[2rem]">
            {state.lastTranscript ?? "音声を待っています..."}
          </p>
          {state.taskFailing && (
            <p className="text-xs text-yellow-700">
              {state.taskMessage ?? "タスク抽出でエラーが発生中"}
            </p>
          )}
        </div>
      );
    case "reconnecting":
      return (
        <p className="text-sm text-yellow-700">
          接続を回復しています。音声は記録されています
        </p>
      );
    case "stopping":
      return <p className="text-sm text-muted-foreground">停止処理中...</p>;
    case "error":
      return <p className="text-sm text-destructive">{state.message}</p>;
  }
}

function CompletionBanner({ notice }: { notice: CompletionNotice }) {
  const Icon = notice.warning ? AlertTriangle : CheckCircle;
  const colors = notice.warning
    ? { border: "border-yellow-200", bg: "bg-yellow-50", icon: "text-yellow-600", text: "text-yellow-800" }
    : { border: "border-green-200", bg: "bg-green-50", icon: "text-green-600", text: "text-green-800" };

  return (
    <div className={`flex items-start gap-2 rounded-lg border p-3 ${colors.border} ${colors.bg}`}>
      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${colors.icon}`} />
      <p className={`text-sm ${colors.text}`}>{notice.text}</p>
    </div>
  );
}
