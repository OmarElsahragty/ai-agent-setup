import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { sessionsDb } from '../../../../modules/database/index.js';
import { normalizeSessionName } from '../../../../shared/utils.js';

export class AgySessionSynchronizer {
    provider = 'agy';

    async synchronize(since) {
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
        if (!fsSync.existsSync(brainDir)) {
            return 0;
        }

        let processed = 0;
        try {
            const entries = fsSync.readdirSync(brainDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const sessionId = entry.name;
                const transcriptPath = path.join(brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl');
                if (!fsSync.existsSync(transcriptPath)) continue;

                try {
                    const stat = fsSync.statSync(transcriptPath);
                    if (since && stat.mtimeMs < since.getTime()) {
                        continue;
                    }

                    const metadata = await this.readSessionMetadata(transcriptPath);
                    const customName = metadata.prompt ? normalizeSessionName(metadata.prompt) : `Agy Session ${sessionId.slice(0, 8)}`;
                    const projectPath = metadata.cwd || process.env.AI_SETUP_ROOT || os.homedir();
                    const createdAt = stat.birthtime.toISOString();
                    const updatedAt = stat.mtime.toISOString();

                    sessionsDb.createSession(
                        sessionId,
                        'agy',
                        projectPath,
                        customName,
                        createdAt,
                        updatedAt,
                        transcriptPath,
                    );
                    processed++;
                } catch {
                    // skip unreadable session
                }
            }
        } catch (err) {
            console.warn('[AgySessionSynchronizer] synchronize failed:', err);
        }
        return processed;
    }

    async synchronizeFile(filePath) {
        if (!filePath || !filePath.endsWith('transcript.jsonl')) {
            return null;
        }
        const parts = filePath.split(path.sep);
        const brainIdx = parts.lastIndexOf('brain');
        if (brainIdx === -1 || brainIdx + 1 >= parts.length) {
            return null;
        }
        const sessionId = parts[brainIdx + 1];
        if (!sessionId) return null;

        try {
            const stat = fsSync.statSync(filePath);
            const metadata = await this.readSessionMetadata(filePath);
            const customName = metadata.prompt ? normalizeSessionName(metadata.prompt) : `Agy Session ${sessionId.slice(0, 8)}`;
            const projectPath = metadata.cwd || process.env.AI_SETUP_ROOT || os.homedir();

            return sessionsDb.createSession(
                sessionId,
                'agy',
                projectPath,
                customName,
                stat.birthtime.toISOString(),
                stat.mtime.toISOString(),
                filePath,
            );
        } catch {
            return null;
        }
    }

    async readSessionMetadata(transcriptPath) {
        const result = { prompt: null, cwd: null };
        try {
            const fileStream = fsSync.createReadStream(transcriptPath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity,
            });

            for await (const line of rl) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    if (entry.type === 'USER_INPUT' && entry.content) {
                        const raw = String(entry.content);
                        const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                        result.prompt = (match && match[1]) ? match[1].trim() : raw.trim();
                        break;
                    }
                } catch {}
            }
        } catch {}
        return result;
    }
}
