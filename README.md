# Cursor Agent Sidebar

VSCode / Cursor の **Secondary Side Bar**（右側サイドバー）から、Cursor CLI の `agent` とチャットできる拡張機能です。

[ACP (Agent Client Protocol)](https://cursor.com/docs/cli/acp) を使い、`agent acp` サブプロセスと JSON-RPC で通信します。

## 前提条件

1. **Cursor CLI** がインストール済みであること
   ```bash
   agent --version
   ```
2. **認証済み**であること
   ```bash
   agent login
   agent status
   ```

## セットアップ

```bash
npm install
npm run compile
```

### 開発時の実行

1. VSCode / Cursor でこのフォルダを開く
2. `F5` で Extension Development Host を起動
3. Secondary Side Bar（右側）に **Cursor Agent** パネルが表示されます

### インストール（VSIX）

```bash
npm run package   # vsce が必要
```

生成された `.vsix` を `Extensions: Install from VSIX...` でインストールします。

## 使い方

- **Agent / Plan / Ask** モードをドロップダウンで切り替え
- メッセージ入力後 **送信**（Enter）または **新規** でチャットをリセット
- ツール実行時は VSCode のダイアログで許可/拒否を選択

## 設定

| 設定 | 説明 | デフォルト |
|------|------|-----------|
| `cursorAgent.agentPath` | `agent` コマンドのパス | `agent` |
| `cursorAgent.model` | モデル名（未使用・将来用） | 空 |
| `cursorAgent.autoApprovePermissions` | ツール実行を自動承認 | `false` |

Windows で `agent` が PATH にない場合:

```json
{
  "cursorAgent.agentPath": "C:\\Users\\<user>\\AppData\\Local\\cursor-agent\\agent.cmd"
}
```

## アーキテクチャ

```
Secondary Side Bar (Webview)
        ↕ postMessage
Extension Host (chatViewProvider.ts)
        ↕ stdio JSON-RPC (ACP)
agent acp (Cursor CLI)
```

## ライセンス

MIT
