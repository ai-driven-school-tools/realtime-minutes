# リアルタイム議事録システム

# サーバー起動
start *args:
    #!/usr/bin/env bash
    command -v node >/dev/null 2>&1 || { echo "Node.js がインストールされていません。https://nodejs.org/ からインストールしてください"; exit 1; }
    command -v pnpm >/dev/null 2>&1 || { echo "pnpm がインストールされていません。npm install -g pnpm を実行してください"; exit 1; }
    [ -d node_modules ] || pnpm install
    pnpm tsx server/preflight.ts
    pnpm dev {{args}}

# サーバー停止
stop:
    #!/usr/bin/env bash
    pids=$(lsof -ti :3001,:5173 2>/dev/null)
    [[ -n "$pids" ]] && kill $pids 2>/dev/null || true

# サーバー再起動
restart *args:
    just stop
    just start {{args}}
