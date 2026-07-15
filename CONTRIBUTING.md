# 贡献说明

所有 Pull Request 必须基于最新的 `main` 修改。主分支更新后，尚未合并的 PR 需要重新同步并通过检查。

## 创建分支

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c <your-branch>
```

## 提交前同步

```bash
git fetch origin
git rebase origin/main
npm ci
npm run check
npm test
git diff --check origin/main...HEAD
```

如果已向自己的 PR 分支推送过提交，rebase 后使用：

```bash
git push --force-with-lease
```

不要对共享分支或 `main` 使用强制推送。

## 合并要求

- 所有修改必须通过 Pull Request 合并到 `main`。
- PR 分支必须包含最新的 `main`，落后时检查会失败并阻止合并。
- `PR checks / validate` 必须通过。
- 未解决的审查讨论会阻止合并。
- 禁止删除 `main` 或对其强制推送。

## 敏感文件

不得提交真实的 `.env`、`runtime/`、`node_modules/`、密码、Token、Cookie、API Key 或本机运行数据。
