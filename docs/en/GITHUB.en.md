English version of [GITHUB.md](../GITHUB.md).

# Uploading to GitHub: complete command checklist

This document assumes you are already in the root of this repository and that Git is installed locally. The `<...>` parts of the commands are placeholders; replace them with your own values.

## Contents

- [0. Prerequisites](#0-prerequisites)
- [1. Configure the Git identity](#1-configure-the-git-identity)
- [2. Check and commit](#2-check-and-commit)
- [3. Create the GitHub repository](#3-create-the-github-repository)
- [4. Add the remote and push](#4-add-the-remote-and-push)
- [5. Verify](#5-verify)
- [6. Subsequent updates](#6-subsequent-updates)
- [7. Troubleshooting](#7-troubleshooting)

## 0. Prerequisites

```bash
git --version
git status
git branch --show-current
git remote -v
```

This repository has already been `git init`-ed; the current branch is `main`, it already has a commit, and `origin` is configured. The “create repository / add remote” steps below apply to a brand-new repository; if you are only pushing this round of changes, go straight to section 6. If you received a clean directory and need to initialize it again, run:

```bash
git init
```

## 1. Configure the Git identity

Configure it only once (replace the placeholders with your GitHub username and email):

```bash
git config --global user.name "<your name>"
git config --global user.email "<your email>"
git config --global init.defaultBranch main
```

If you want it to apply to this repository only, drop `--global`.

It is also a good idea to confirm the line-ending strategy, so that Windows does not produce a whole-repo diff:

```bash
git config --global core.autocrlf true
```

## 2. Check and commit

```bash
cd <repository root>
git status
git branch -M main

git add .
git status
git diff --cached --stat

git commit -m "feat: add DSH auto context compression plugin with live Web UI"
git log --oneline --decorate -5
```

Notes:

- `.gitignore` already excludes `node_modules/`, logs, editor directories and temporary files;
- `git add .` stages every non-ignored file under the current directory;
- before committing, look at `git diff --cached --stat` and confirm that no local files such as `status.json`, `config.json`, tokens, or exported reports/images are included;
- if something was added by mistake, run `git restore --staged <file>`; do not commit it directly with `git commit`.

## 3. Create the GitHub repository

If `git remote -v` already shows `origin` (as this repository does), skip this section and go to section 6.

### Option A: GitHub CLI (recommended)

```bash
gh --version
gh auth login
gh repo create <repository name> --public --source=. --remote=origin --push
```

If you want a private repository, replace `--public` with `--private`. `gh repo create` adds `origin` automatically and pushes the current branch.

### Option B: Create in the browser

1. Open <https://github.com/new>;
2. Fill in the repository name and choose Public/Private;
3. **Do not** tick "Add a README file", "Add .gitignore" or "Choose a license"; keep the repository empty;
4. After creating it, copy the repository URL and continue with the next section.

## 4. Add the remote and push

### HTTPS

```bash
git remote add origin https://github.com/<your GitHub username>/<repository name>.git
git remote -v
git push -u origin main
```

### SSH

```bash
git remote add origin git@github.com:<your GitHub username>/<repository name>.git
git remote -v
git push -u origin main
```

If `origin` already exists (for example because you used `gh repo create`):

```bash
git remote set-url origin https://github.com/<your GitHub username>/<repository name>.git
git push -u origin main
```

If the push is rejected and the remote repository already has a README/initial commit:

```bash
git pull --rebase origin main
git push -u origin main
```

## 5. Verify

```bash
git status
git branch -vv
git remote -v
git log --oneline --decorate -5
git ls-remote --heads origin
```

Open in the browser:

```text
https://github.com/<your GitHub username>/<repository name>
```

Confirm that the repository contains `README.md`, `SECURITY_REVIEW.md`, `WEBSOCKET_REVIEW.md`, `lib/`, `client.js`, `test/`, `tools/`, and no `node_modules/`.

## 6. Subsequent updates

For this round of changes, run:

```bash
git add -A
git commit -m "refactor: split host helpers; docs: add bilingual docs and group docs/"
git push
```

If the remote has new commits:

```bash
git pull --rebase
git push
```

View the differences:

```bash
git diff
git diff --cached
git log --stat -3
```

## 7. Troubleshooting

### 7.1 `remote origin already exists`

```bash
git remote set-url origin <new repository URL>
```

### 7.2 Push asks for a PAT

GitHub no longer accepts account passwords. Use a Personal Access Token (classic or fine-grained) as the HTTPS password, or switch to SSH:

```bash
git remote set-url origin git@github.com:<your GitHub username>/<repository name>.git
```

### 7.3 The default branch is not `main`

```bash
git branch -M main
git push -u origin main
```

### 7.4 A local file was committed by mistake

```bash
git restore --staged <file>
git rm --cached <file>
```

If the file has already been committed into history and you need to rewrite history, back up first and use `git filter-repo`; do not force-push a repository shared by several people.

### 7.5 Check what will be pushed

```bash
git log origin/main..HEAD --oneline
git diff origin/main..HEAD --stat
```

Project overview: [README.en.md](../../README.en.md).
