---
name: homelab
description: Homelab infrastructure commands, Docker management, and service operations for this Ubuntu server. Use when working with Docker, systemd, networking, or any infrastructure tasks.
---

# Homelab Infrastructure Skill

## Server Identity

- Host: this machine (any Linux host with systemd)
- OS: Ubuntu 26.04 LTS 7.0.0-22
- Domain: ${AI_SETUP_DOMAIN} via Cloudflare Tunnel

## Quick Commands

### Docker Compose (primary stack)

```bash
cd ${AI_SETUP_ROOT} && docker compose ps
cd ${AI_SETUP_ROOT} && docker compose logs -f --tail=100 <service>
cd ${AI_SETUP_ROOT} && docker compose pull && docker compose up -d
cd ${AI_SETUP_ROOT} && docker compose restart <service>
```

### System Status

```bash
docker stats --no-stream
free -h
df -h /
systemctl status <service>
journalctl -u <service> -f
```

### Networking

- Zero inbound ports — Cloudflare Tunnel QUIC outbound only
- SSH: ed25519 key-only, UFW SSH only
- Containers: no-new-privileges, non-root

## Restarting cloudcli (${AI_SETUP_DOMAIN})
All web-UI Claude sessions and their subagents live in `cloudcli.service`'s cgroup. Never `systemctl restart cloudcli`; run
`${AI_SETUP_ROOT}/scripts/safe-restart.sh cloudcli` — it detaches via systemd-run, waits until no `claude.exe` is running in the
cgroup (max 60 min, then abandons without restarting), restarts and health-checks. Log: `/var/tmp/claude/safe-restart.log`.

## Security

- Secrets in ${AI_SETUP_ROOT}/.env (gitignored)
- ${AI_SETUP_ROOT}${AI_SETUP_ROOT}/.env (chmod 600)
- Never commit or expose ports
- Never break running services

## Conventions

- Shell: bash + set -euo pipefail
- Stack: Node 22, npm, Python 3.14, Docker 29.4, Git 2.53

## Status Check

Run: `cd ${AI_SETUP_ROOT} && docker compose ps && docker stats --no-stream && free -h && df -h /`

## Logs

Run: `cd ${AI_SETUP_ROOT} && docker compose logs -f --tail=100`

## Deploy

Run: `cd ${AI_SETUP_ROOT} && docker compose pull && docker compose up -d`
