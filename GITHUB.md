# 上传到 GitHub：完整命令清单

> [English](./GITHUB.en.md) | 简体中文

本文假设你已经在本仓库根目录，且本机已安装 Git。命令中的 `<...>` 是占位符，请替换成自己的值。

## 目录

- [0. 前置检查](#0-前置检查)
- [1. 配置 Git 身份](#1-配置-git-身份)
- [2. 检查并提交](#2-检查并提交)
- [3. 创建 GitHub 仓库](#3-创建-github-仓库)
- [4. 关联远程并推送](#4-关联远程并推送)
- [5. 验证](#5-验证)
- [6. 后续更新](#6-后续更新)
- [7. 常见问题](#7-常见问题)

## 0. 前置检查

```bash
git --version
git status
git branch --show-current
git remote -v
```

本仓库已经执行过 `git init`，当前分支是 `main`，已有提交，并已配置 `origin`。下面的“创建仓库 / 关联远程”步骤适用于全新仓库；如果你只是把本轮修改推上去，直接执行第 6 节。若你拿到的是干净目录、需要重新初始化，再执行：

```bash
git init
```

## 1. 配置 Git 身份

只配置一次即可（把占位符换成你的 GitHub 用户名和邮箱）：

```bash
git config --global user.name "<你的名字>"
git config --global user.email "<你的邮箱>"
git config --global init.defaultBranch main
```

如果只想对本仓库生效，去掉 `--global`。

建议同时确认换行策略，避免 Windows 上出现整仓 diff：

```bash
git config --global core.autocrlf true
```

## 2. 检查并提交

```bash
cd <仓库根目录>
git status
git branch -M main

git add .
git status
git diff --cached --stat

git commit -m "feat: add DSH auto context compression plugin with live Web UI"
git log --oneline --decorate -5
```

说明：

- `.gitignore` 已排除 `node_modules/`、日志、编辑器目录和临时文件；
- `git add .` 会把当前目录下未被忽略的文件全部加入暂存区；
- 提交前先看 `git diff --cached --stat`，确认没有 `status.json`、`config.json`、token、导出的报告/图片等本地文件；
- 如果发现误加入，执行 `git restore --staged <文件>`，不要直接 `git commit`。

## 3. 创建 GitHub 仓库

如果 `git remote -v` 已经显示 `origin`（本仓库即是），跳过本节，直接看第 6 节。

### 方式 A：GitHub CLI（推荐）

```bash
gh --version
gh auth login
gh repo create <仓库名> --public --source=. --remote=origin --push
```

如果希望创建私有仓库，把 `--public` 换成 `--private`。`gh repo create` 会自动添加 `origin` 并推送当前分支。

### 方式 B：网页创建

1. 打开 <https://github.com/new>；
2. 填写仓库名，选择 Public/Private；
3. **不要**勾选 “Add a README file”“Add .gitignore”“Choose a license”，保持空仓库；
4. 创建后复制仓库地址，继续下一节。

## 4. 关联远程并推送

### HTTPS

```bash
git remote add origin https://github.com/<你的GitHub用户名>/<仓库名>.git
git remote -v
git push -u origin main
```

### SSH

```bash
git remote add origin git@github.com:<你的GitHub用户名>/<仓库名>.git
git remote -v
git push -u origin main
```

如果 `origin` 已存在（例如用了 `gh repo create`）：

```bash
git remote set-url origin https://github.com/<你的GitHub用户名>/<仓库名>.git
git push -u origin main
```

如果推送被拒绝，且远程仓库已经有 README/初始提交：

```bash
git pull --rebase origin main
git push -u origin main
```

## 5. 验证

```bash
git status
git branch -vv
git remote -v
git log --oneline --decorate -5
git ls-remote --heads origin
```

浏览器打开：

```text
https://github.com/<你的GitHub用户名>/<仓库名>
```

确认仓库里有 `README.md`、`SECURITY_REVIEW.md`、`WEBSOCKET_REVIEW.md`、`lib/`、`client.js`、`test/`、`tools/`，并且没有 `node_modules/`。

## 6. 后续更新

本轮双语改动直接执行：

```bash
git add .
git commit -m "refactor: split host helpers; docs: add bilingual comments and English docs"
git push
```

如果远程有新提交：

```bash
git pull --rebase
git push
```

查看差异：

```bash
git diff
git diff --cached
git log --stat -3
```

## 7. 常见问题

### 7.1 `remote origin already exists`

```bash
git remote set-url origin <新的仓库地址>
```

### 7.2 推送要求 PAT

GitHub 不再接受账户密码。使用 Personal Access Token（classic 或 fine-grained）作为 HTTPS 密码，或改用 SSH：

```bash
git remote set-url origin git@github.com:<你的GitHub用户名>/<仓库名>.git
```

### 7.3 默认分支不是 `main`

```bash
git branch -M main
git push -u origin main
```

### 7.4 误提交了本地文件

```bash
git restore --staged <文件>
git rm --cached <文件>
```

如果文件已被提交进历史，需要重写历史时请先备份，并使用 `git filter-repo`；不要在多人仓库上直接强推。

### 7.5 查看当前将推送什么

```bash
git log origin/main..HEAD --oneline
git diff origin/main..HEAD --stat
```
