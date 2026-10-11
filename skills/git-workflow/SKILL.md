---
name: git-workflow
description: Git workflow conventions and commit message format for the homelab repository. Use when committing changes, creating branches, or working with git.
---

# Git Workflow Skill

## Commit Message Format

```
<type>: <short description>

<body>

<footer>
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Formatting, missing semicolons, etc
- `refactor`: Code restructuring without behavior change
- `test`: Adding or updating tests
- `chore`: Maintenance tasks
- `perf`: Performance improvements

### Examples

```
feat: add unified-memory MCP server

- Add pgvector-backed memory with topic SOT architecture
- Implement search_memory, append_memory, recall_memory tools
```

## Branch Naming

```
feat/<description>
fix/<description>
chore/<description>
```

## Rules

1. NEVER commit secrets or .env files
2. Read b4 commit — check git status and diff
3. Write concise commit messages
4. No proactive commits — wait for explicit request
5. No force-push unless explicitly requested

## Commit Workflow

1. Run `git status` and `git diff --staged`
2. Stage appropriate files: `git add <files>`
3. Commit with message following the format above
4. Do NOT push unless explicitly asked
