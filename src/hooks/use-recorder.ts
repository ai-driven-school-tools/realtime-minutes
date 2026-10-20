import { useState, useRef, useCallback } from "react";

export interface CompletionNotice {
  text: string;
  warning: boolean;
}

export type RecorderState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "recording"; outputPath: string; lastTranscript: string | null; taskCount: number; taskFailing: boolean; taskMessage?: string }
  | { status: "reconnecting" }
  | { status: "stopping" }
  | { status: "error"; code: string; message: string };

const WS_URL = `ws://localhost:3001`;
const STOP_TIMEOUT_MS = 10_000;
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_INTERVAL_MS = 250;

const MIC_ERRORS: Record<string, { code: string; message: string }> = {
  NotAllowedError: {
    code: "MIC_NOT_ALLOWED",
    message: "マイクがブロックされています。アドレスバーの鍵アイコン →「サイトの設定」→ マイク →「許可」に変更し、ページを再読み込みしてください",
  },
  NotFoundError: {
    code: "MIC_NOT_FOUND",
    message: "マイクが検出されません。マイクの接続を確認してください",
  },
  NotReadableError: {
    code: "MIC_IN_USE",
    message: "マイクが他のアプリに使用されています。他の通話アプリを終了してください",
  },
};

function toMicError(err: unknown): RecorderState & { status: "error" } {
  if (err instanceof DOMException && err.name in MIC_ERRORS) {
    const mapped = MIC_ERRORS[err.name]!;
    return { status: "error", code: mapped.code, message: mapped.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: "error", code: "MIC_UNKNOWN", message: `マイクの初期化に失敗しました: ${message}` };
}

function buildCompletionNotice(
  taskCount: number,
  failing: boolean,
  outputPath: string,
): CompletionNotice {
  if (failing) {
    return {
      text: taskCount > 0
        ? `録音を終了しました。タスク ${taskCount} 件抽出済み（一部失敗あり）`
        : "録音を終了しました。タスク抽出に失敗しています",
      warning: true,
    };
  }
  return {
    text: taskCount > 0
      ? `録音を終了しました。タスク ${taskCount} 件抽出済み`
      : `録音を終了しました。ファイルは ${outputPath} に保存されています`,
    warning: false,
  };
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>({ status: "idle" });
  const [completionNotice, setCompletionNotice] = useState<CompletionNotice | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outputPathRef = useRef<string>("");

  const cleanup = useCallback(() => {
    if (stopTimeoutRef.current) {
      clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setCompletionNotice(null);
    setState({ status: "connecting" });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      setState(toMicError(err));
      return;
    }
    streamRef.current = stream;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        switch (msg.type) {
          case "ready":
            outputPathRef.current = String(msg.outputPath ?? "");
            setState({
              status: "recording",
              outputPath: outputPathRef.current,
              lastTranscript: null,
              taskCount: 0,
              taskFailing: false,
            });
            break;
          case "transcript":
            if (msg.isFinal) {
              setState((prev) =>
                prev.status === "recording"
                  ? { ...prev, lastTranscript: String(msg.text ?? "") }
                  : prev,
              );
            }
            break;
          case "task_status":
            setState((prev) =>
              prev.status === "recording"
                ? {
                    ...prev,
                    taskCount: Number(msg.taskCount ?? prev.taskCount),
                    taskFailing: Boolean(msg.failing),
                    taskMessage: msg.message ? String(msg.message) : undefined,
                  }
                : prev,
            );
            break;
          case "reconnecting":
            setState({ status: "reconnecting" });
            break;
          case "reconnected":
            setState((prev) => ({
              status: "recording",
              outputPath: outputPathRef.current,
              lastTranscript: null,
              taskCount: prev.status === "recording" ? prev.taskCount : 0,
              taskFailing: prev.status === "recording" ? prev.taskFailing : false,
            }));
            break;
          case "stopping":
            setState({ status: "stopping" });
            break;
          case "stopped": {
            if (stopTimeoutRef.current) {
              clearTimeout(stopTimeoutRef.current);
              stopTimeoutRef.current = null;
            }
            cleanup();
            setCompletionNotice(
              buildCompletionNotice(
                Number(msg.taskCount ?? 0),
                Boolean(msg.failing),
                outputPathRef.current,
              ),
            );
            setState({ status: "idle" });
            break;
          }
          case "error":
            cleanup();
            setState({
              status: "error",
              code: String(msg.code ?? "UNKNOWN"),
              message: String(msg.message ?? "不明なエラーが発生しました"),
            });
            break;
        }
      } catch {
        /* ignore malformed JSON */
      }
    };

    ws.onerror = () => {
      cleanup();
      setState({
        status: "error",
        code: "WS_ERROR",
        message: "サーバーとの接続に失敗しました。サーバーが起動しているか確認してください",
      });
    };

    ws.onclose = () => {
      setState((prev) =>
        prev.status === "idle" || prev.status === "error" ? prev : { status: "idle" },
      );
    };

    ws.onopen = () => {
      const audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);

      let pcmBuffer: Int16Array[] = [];
      let sendTimer: ReturnType<typeof setInterval> | null = null;

      processor.onaudioprocess = (e) => {
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]!));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        pcmBuffer.push(int16);
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      sendTimer = setInterval(() => {
        if (pcmBuffer.length === 0 || ws.readyState !== WebSocket.OPEN) return;
        const chunks = pcmBuffer;
        pcmBuffer = [];
        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Int16Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        ws.send(merged.buffer);
      }, CHUNK_INTERVAL_MS);

      const dummyRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      recorderRef.current = dummyRecorder;
      const origStop = dummyRecorder.stop.bind(dummyRecorder);
      dummyRecorder.stop = () => {
        if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
        processor.disconnect();
        source.disconnect();
        origStop();
      };
      dummyRecorder.start();
    };
  }, [cleanup]);

  const stop = useCallback(() => {
    setState({ status: "stopping" });

    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
    }

    stopTimeoutRef.current = setTimeout(() => {
      cleanup();
      setCompletionNotice({
        text: "停止処理がタイムアウトしました。一部の発話が保存されなかった可能性があります",
        warning: true,
      });
      setState({ status: "idle" });
    }, STOP_TIMEOUT_MS);
  }, [cleanup]);

  const retry = useCallback(() => {
    cleanup();
    setCompletionNotice(null);
    setState({ status: "idle" });
  }, [cleanup]);

  return { state, start, stop, retry, completionNotice };
}
