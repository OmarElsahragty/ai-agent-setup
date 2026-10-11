import crossSpawn from 'cross-spawn';
import {
    createCompleteMessage,
    createNormalizedMessage,
    flattenPromptForWindowsShell,
} from '../../../../shared/utils.js';
import { notifyRunFailed, notifyRunStopped } from '../../../../modules/notifications/index.js';

const spawnFunction = crossSpawn;
const activeAgyProcesses = new Map();

/**
 * Maps the CloudCLI permission mode onto agy's CLI flags.
 */
export function resolveAgyPermissionOptions(permissionMode) {
    switch (permissionMode) {
        case 'plan':
            return { args: ['--mode', 'plan'], env: {} };
        case 'acceptEdits':
            return { args: ['--mode', 'accept-edits'], env: {} };
        case 'bypassPermissions':
        case 'auto':
            return { args: ['--dangerously-skip-permissions'], env: {} };
        default:
            return { args: [], env: {} };
    }
}

export function resolveAgyEffort(effort) {
    const validEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    return typeof effort === 'string' && validEfforts.includes(effort.toLowerCase())
        ? effort.toLowerCase()
        : undefined;
}

export class AgyRuntimeProvider {
    async run(command, options = {}, ws, context) {
        return new Promise((resolve, reject) => {
            const {
                sessionId,
                projectPath,
                cwd,
                model,
                effort,
                sessionSummary,
                permissionMode,
            } = options;

            const providerSessionId = context?.resolveProviderSessionId?.(sessionId) || null;
            const workingDir = cwd || projectPath || process.cwd();
            const processKey = sessionId || Date.now().toString();

            let capturedSessionId = providerSessionId;
            let sessionCreatedSent = false;
            let stdoutLineBuffer = '';
            let terminalNotificationSent = false;
            let agyProcess = null;
            let completeSent = false;
            let currentTokenBudget = null;

            const notifyTerminalState = ({ code = null, error = null } = {}) => {
                if (terminalNotificationSent) return;
                terminalNotificationSent = true;
                const finalSessionId = sessionId || capturedSessionId || processKey;
                if (code === 0 && !error) {
                    notifyRunStopped({
                        userId: ws?.userId || null,
                        provider: 'agy',
                        sessionId: finalSessionId,
                        sessionName: sessionSummary,
                        stopReason: 'completed',
                    });
                    return;
                }
                notifyRunFailed({
                    userId: ws?.userId || null,
                    provider: 'agy',
                    sessionId: finalSessionId,
                    sessionName: sessionSummary,
                    error: error || `agy CLI exited with code ${code}`,
                });
            };

            const registerSession = (nextSessionId) => {
                if (!nextSessionId || capturedSessionId === nextSessionId) return;
                capturedSessionId = nextSessionId;

                if (!sessionId && processKey !== capturedSessionId && agyProcess) {
                    activeAgyProcesses.delete(processKey);
                    activeAgyProcesses.set(capturedSessionId, agyProcess);
                }
                if (agyProcess) {
                    agyProcess.sessionId = capturedSessionId;
                }
                if (ws?.setSessionId && typeof ws.setSessionId === 'function') {
                    ws.setSessionId(capturedSessionId);
                }
                if (!providerSessionId && !sessionCreatedSent) {
                    sessionCreatedSent = true;
                    ws.send(createNormalizedMessage({
                        kind: 'session_created',
                        newSessionId: capturedSessionId,
                        sessionId: capturedSessionId,
                        provider: 'agy',
                    }));
                }
            };

            const processOutputLine = (line) => {
                if (!line || !line.trim()) return;

                let payload;
                try {
                    payload = JSON.parse(line);
                } catch {
                    // Raw string line
                    ws.send(createNormalizedMessage({
                        kind: 'stream_delta',
                        content: line + '\n',
                        sessionId: capturedSessionId || sessionId || null,
                        provider: 'agy',
                    }));
                    return;
                }

                try {
                    const finalSessionId = capturedSessionId || sessionId || null;

                    // 1. Session initialization
                    if (payload.conversation_id) {
                        registerSession(payload.conversation_id);
                    }

                    // 2. Step updates
                    if (payload.event === 'step_update' && payload.step_update) {
                        const step = payload.step_update;

                        // Text stream delta
                        if (step.step_type === 'agent_response' && step.text_delta) {
                            ws.send(createNormalizedMessage({
                                kind: 'stream_delta',
                                content: step.text_delta,
                                sessionId: finalSessionId,
                                provider: 'agy',
                            }));
                        }

                        // Tool call
                        if (step.step_type === 'tool') {
                            if (step.state === 'ACTIVE') {
                                ws.send(createNormalizedMessage({
                                    kind: 'tool_call',
                                    toolId: `tool_${step.step_index}`,
                                    toolName: step.tool_name || 'Tool',
                                    toolInput: step.tool_info?.parameters || {},
                                    sessionId: finalSessionId,
                                    provider: 'agy',
                                }));
                            } else if (step.state === 'DONE') {
                                ws.send(createNormalizedMessage({
                                    kind: 'tool_result',
                                    toolId: `tool_${step.step_index}`,
                                    toolName: step.tool_name || 'Tool',
                                    toolResult: {
                                        content: typeof step.tool_info?.output === 'string'
                                            ? step.tool_info.output
                                            : JSON.stringify(step.tool_info?.output ?? ''),
                                    },
                                    sessionId: finalSessionId,
                                    provider: 'agy',
                                }));
                            }
                        }
                    }

                    // 3. Final Turn Result & Token Budget
                    if (payload.event === 'result' && payload.result) {
                        const res = payload.result;
                        if (res.usage) {
                            const inputTokens = Number(res.usage.input_tokens || 0);
                            const outputTokens = Number(res.usage.output_tokens || 0);
                            const totalTokens = Number(res.usage.total_tokens || inputTokens + outputTokens);
                            currentTokenBudget = {
                                used: totalTokens,
                                inputTokens,
                                outputTokens,
                                breakdown: {
                                    input: inputTokens,
                                    output: outputTokens,
                                },
                            };
                            ws.send(createNormalizedMessage({
                                kind: 'status',
                                text: 'token_budget',
                                tokenBudget: currentTokenBudget,
                                sessionId: finalSessionId,
                                provider: 'agy',
                            }));
                        }
                    }
                } catch (err) {
                    console.error('[Agy] Failed to parse output line:', err);
                }
            };

            const runAgy = async () => {
                const resolvedModel = await context?.resolveResumeModel?.(sessionId, model) || model || 'gemini-3.8-flash-high';
                const resolvedEffort = resolveAgyEffort(effort);

                const args = ['-p'];
                const promptText = flattenPromptForWindowsShell(command?.trim() || '');
                args.push(promptText);
                args.push('--output-format', 'stream-json');

                if (providerSessionId) {
                    args.push('--conversation', providerSessionId);
                }
                if (resolvedModel) {
                    args.push('--model', resolvedModel);
                }
                if (resolvedEffort) {
                    args.push('--effort', resolvedEffort);
                }

                const permissionOptions = resolveAgyPermissionOptions(permissionMode);
                args.push(...permissionOptions.args);

                agyProcess = spawnFunction('agy', args, {
                    cwd: workingDir,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: { ...process.env, ...permissionOptions.env },
                });

                activeAgyProcesses.set(processKey, agyProcess);
                agyProcess.sessionId = processKey;
                agyProcess.stdin.end();

                agyProcess.stdout.on('data', (chunk) => {
                    stdoutLineBuffer += chunk.toString();
                    const lines = stdoutLineBuffer.split(/\r?\n/);
                    stdoutLineBuffer = lines.pop() || '';
                    for (const line of lines) {
                        processOutputLine(line.trim());
                    }
                });

                agyProcess.stderr.on('data', (chunk) => {
                    const text = chunk.toString();
                    if (!text.trim()) return;
                    ws.send(createNormalizedMessage({
                        kind: 'error',
                        content: text,
                        sessionId: capturedSessionId || sessionId || null,
                        provider: 'agy',
                    }));
                });

                agyProcess.on('close', (code) => {
                    const finalSessionId = sessionId || capturedSessionId || processKey;
                    activeAgyProcesses.delete(finalSessionId);
                    activeAgyProcesses.delete(processKey);

                    if (stdoutLineBuffer.trim()) {
                        processOutputLine(stdoutLineBuffer.trim());
                        stdoutLineBuffer = '';
                    }

                    if (currentTokenBudget) {
                        ws.send(createNormalizedMessage({
                            kind: 'status',
                            text: 'token_budget',
                            tokenBudget: currentTokenBudget,
                            sessionId: finalSessionId,
                            provider: 'agy',
                        }));
                    }

                    if (!completeSent && !agyProcess.aborted) {
                        completeSent = true;
                        ws.send(createCompleteMessage({
                            provider: 'agy',
                            sessionId: finalSessionId,
                            exitCode: code,
                        }));
                    }

                    notifyTerminalState({ code });
                    resolve({ sessionId: finalSessionId, exitCode: code });
                });

                agyProcess.on('error', (err) => {
                    const finalSessionId = sessionId || capturedSessionId || processKey;
                    activeAgyProcesses.delete(finalSessionId);
                    activeAgyProcesses.delete(processKey);

                    if (!completeSent) {
                        completeSent = true;
                        ws.send(createNormalizedMessage({
                            kind: 'error',
                            content: err.message,
                            sessionId: finalSessionId,
                            provider: 'agy',
                        }));
                        ws.send(createCompleteMessage({
                            provider: 'agy',
                            sessionId: finalSessionId,
                            exitCode: 1,
                        }));
                    }

                    notifyTerminalState({ error: err.message });
                    reject(err);
                });
            };

            void runAgy();
        });
    }

    async abort(sessionId) {
        if (!sessionId) return false;
        const proc = activeAgyProcesses.get(sessionId);
        if (proc) {
            proc.aborted = true;
            proc.kill('SIGTERM');
            activeAgyProcesses.delete(sessionId);
            return true;
        }
        return false;
    }
}

export const agyRuntime = new AgyRuntimeProvider();
