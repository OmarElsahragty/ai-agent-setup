import { mkdir, readFile, writeFile } from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpProvider } from '../../../../modules/providers/shared/mcp/mcp.provider.js';
import { AppError, readObjectRecord, readOptionalString } from '../../../../shared/utils.js';

const readConfig = async (filePath) => {
    try {
        const content = await readFile(filePath, 'utf8');
        return readObjectRecord(JSON.parse(content)) ?? {};
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
    }
};

const writeConfig = async (filePath, data) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const resolveAgyConfigPath = (scope, workspacePath) => {
    if (scope === 'user') {
        return path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
    }
    return path.join(workspacePath, '.gemini', 'mcp_config.json');
};

export class AgyMcpProvider extends McpProvider {
    constructor() {
        super('agy', ['user', 'project'], ['stdio', 'http', 'sse']);
    }

    async readScopedServers(scope, workspacePath) {
        const filePath = resolveAgyConfigPath(scope, workspacePath);
        const config = await readConfig(filePath);
        return readObjectRecord(config.mcpServers) ?? {};
    }

    async writeScopedServers(scope, workspacePath, servers) {
        const filePath = resolveAgyConfigPath(scope, workspacePath);
        const config = await readConfig(filePath);
        config.mcpServers = servers;
        await writeConfig(filePath, config);
    }

    buildServerConfig(input) {
        if (input.transport === 'stdio') {
            if (!input.command?.trim()) {
                throw new AppError('command is required for stdio MCP servers.', {
                    code: 'MCP_COMMAND_REQUIRED',
                    statusCode: 400,
                });
            }
            return {
                command: input.command,
                args: input.args ?? [],
                env: input.env ?? {},
            };
        }
        if (!input.url?.trim()) {
            throw new AppError('url is required for http MCP servers.', {
                code: 'MCP_URL_REQUIRED',
                statusCode: 400,
            });
        }
        return {
            type: input.transport === 'sse' ? 'sse' : 'http',
            url: input.url,
            headers: input.headers ?? {},
        };
    }

    normalizeServerConfig(scope, name, rawConfig) {
        const config = readObjectRecord(rawConfig);
        if (!config) return null;

        if (config.url) {
            return {
                provider: 'agy',
                name,
                scope,
                transport: config.type === 'sse' ? 'sse' : 'http',
                url: readOptionalString(config.url),
                headers: readObjectRecord(config.headers) ?? {},
            };
        }

        if (config.command) {
            return {
                provider: 'agy',
                name,
                scope,
                transport: 'stdio',
                command: readOptionalString(config.command),
                args: Array.isArray(config.args) ? config.args.map(String) : [],
                env: readObjectRecord(config.env) ?? {},
            };
        }

        return null;
    }
}
