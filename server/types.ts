export interface TaskStatus {
  taskCount: number;
  failing: boolean;
  message?: string;
}

export type ServerMessage =
  | { type: "ready"; outputPath: string }
  | { type: "transcript"; text: string; isFinal: boolean }
  | { type: "reconnecting" }
  | { type: "reconnected" }
  | { type: "stopping" }
  | { type: "stopped" } & TaskStatus
  | { type: "task_status" } & TaskStatus
  | { type: "error"; code: string; message: string };

export type ClientMessage = { type: "stop" };
