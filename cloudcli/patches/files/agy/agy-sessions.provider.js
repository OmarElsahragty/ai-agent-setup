import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { sessionsDb } from '../../../../modules/database/index.js';
import {
    createNormalizedMessage,
    generateMessageId,
    sliceTailPage,
} from '../../../../shared/utils.js';

const PROVIDER = 'agy';

function resolveTranscriptPath(sessionId) {
    if (!sessionId) return null;
    let session = null;
    try {
        session = sessionsDb.getSessionById(sessionId);
    } catch {
        // sessionsDb may not be initialized in test or standalone contexts
    }
    if (session?.jsonl_path && fsSync.existsSync(session.jsonl_path)) {
        return session.jsonl_path;
    }
    const nativeId = session?.provider_session_id || sessionId;
    const defaultPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', nativeId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fsSync.existsSync(defaultPath)) {
        return defaultPath;
    }
    return null;
}

function cleanUserContent(raw) {
    if (typeof raw !== 'string') return '';
    const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
    if (match && match[1]) {
        return match[1].trim();
    }
    return raw.trim();
}

export class AgySessionsProvider {
    provider = PROVIDER;

    normalizeMessage(raw, sessionId) {
        if (!raw || typeof raw !== 'object') {
            return [];
        }
        if (raw.kind) {
            return [createNormalizedMessage({ ...raw, sessionId, provider: PROVIDER })];
        }
        return [];
    }

    async getSessionMessages(sessionId, options = {}) {
        const filePath = resolveTranscriptPath(sessionId);
        if (!filePath) {
            return {
                messages: [],
                hasMore: false,
                total: 0,
            };
        }

        const messages = [];
        let totalTokens = { input: 0, output: 0, cacheRead: 0 };

        try {
            const fileStream = fsSync.createReadStream(filePath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity,
            });

            let lastToolCallId = null;

            for await (const line of rl) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    const ts = entry.created_at || new Date().toISOString();
                    const stepIdx = entry.step_index ?? messages.length;

                    if (entry.input_tokens) totalTokens.input += Number(entry.input_tokens);
                    if (entry.output_tokens) totalTokens.output += Number(entry.output_tokens);
                    if (entry.cache_read_tokens) totalTokens.cacheRead += Number(entry.cache_read_tokens);

                    // 1. User turn
                    if (entry.type === 'USER_INPUT') {
                        const content = cleanUserContent(entry.content);
                        if (content) {
                            messages.push(createNormalizedMessage({
                                id: `msg_u_${stepIdx}`,
                                sessionId,
                                timestamp: ts,
                                provider: PROVIDER,
                                kind: 'text',
                                role: 'user',
                                content,
                            }));
                        }
                        continue;
                    }

                    // 2. Planner / Assistant response
                    if (entry.type === 'PLANNER_RESPONSE') {
                        if (entry.thinking && entry.thinking.trim()) {
                            messages.push(createNormalizedMessage({
                                id: `msg_th_${stepIdx}`,
                                sessionId,
                                timestamp: ts,
                                provider: PROVIDER,
                                kind: 'thinking',
                                content: entry.thinking.trim(),
                            }));
                        }

                        if (Array.isArray(entry.tool_calls)) {
                            for (let i = 0; i < entry.tool_calls.length; i++) {
                                const tc = entry.tool_calls[i];
                                const toolId = `tool_${stepIdx}_${i}`;
                                lastToolCallId = toolId;
                                messages.push(createNormalizedMessage({
                                    id: `msg_tc_${stepIdx}_${i}`,
                                    sessionId,
                                    timestamp: ts,
                                    provider: PROVIDER,
                                    kind: 'tool_use',
                                    toolName: tc.name || 'Tool',
                                    toolInput: typeof tc.args === 'string' ? (() => { try { return JSON.parse(tc.args); } catch { return tc.args; } })() : (tc.args || {}),
                                    toolId,
                                }));
                            }
                        }
                        continue;
                    }

                    // 3. Tool Result / Generic output
                    if (entry.type === 'GENERIC' && entry.content) {
                        const content = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
                        messages.push(createNormalizedMessage({
                            id: `msg_tr_${stepIdx}`,
                            sessionId,
                            timestamp: ts,
                            provider: PROVIDER,
                            kind: 'tool_result',
                            toolName: 'ToolResult',
                            toolResult: {
                                content,
                                isError: entry.status === 'ERROR',
                            },
                            toolId: lastToolCallId || `tool_${stepIdx}`,
                        }));
                        continue;
                    }

                    // 4. Plain Assistant message (if present)
                    if (entry.type === 'ASSISTANT_TEXT' && entry.content) {
                        messages.push(createNormalizedMessage({
                            id: `msg_a_${stepIdx}`,
                            sessionId,
                            timestamp: ts,
                            provider: PROVIDER,
                            kind: 'text',
                            role: 'assistant',
                            content: entry.content,
                        }));
                    }
                } catch {
                    // skip corrupted lines
                }
            }
        } catch (err) {
            console.warn('[AgySessions] Failed to read transcript:', err);
        }

        const { limit = 100, offset = 0 } = options;
        const { page, hasMore } = sliceTailPage(messages, limit, offset);

        return {
            messages: page,
            hasMore,
            total: messages.length,
        };
    }

    async getTokenUsage(sessionId) {
        const filePath = resolveTranscriptPath(sessionId);
        if (!filePath) return undefined;

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;

        try {
            const fileStream = fsSync.createReadStream(filePath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity,
            });

            for await (const line of rl) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    if (entry.input_tokens) inputTokens += Number(entry.input_tokens);
                    if (entry.output_tokens) outputTokens += Number(entry.output_tokens);
                    if (entry.cache_read_tokens) cacheReadTokens += Number(entry.cache_read_tokens);
                } catch {}
            }
        } catch {
            return undefined;
        }

        const totalUsed = inputTokens + outputTokens + cacheReadTokens;
        if (totalUsed <= 0) return undefined;

        return {
            used: totalUsed,
            inputTokens: inputTokens + cacheReadTokens,
            outputTokens,
            breakdown: {
                input: inputTokens + cacheReadTokens,
                output: outputTokens,
            },
        };
    }
}
