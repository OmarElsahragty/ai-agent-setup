import { readFile } from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';

export class AgyProviderAuth {
    /**
     * Checks whether the agy CLI executable is available.
     */
    checkInstalled() {
        try {
            const result = spawn.sync('agy', ['--version'], { stdio: 'ignore', timeout: 5000 });
            return !result.error && result.status === 0;
        } catch {
            return false;
        }
    }

    /**
     * Returns agy CLI installation and credential status.
     */
    async getStatus() {
        const installed = this.checkInstalled();
        const credentials = await this.checkCredentials();
        return {
            installed,
            provider: 'agy',
            authenticated: credentials.authenticated,
            email: credentials.email,
            method: credentials.method,
            error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
        };
    }

    /**
     * Verifies native OAuth credentials or API key environments for Antigravity.
     */
    async checkCredentials() {
        const geminiDir = path.join(os.homedir(), '.gemini');
        const tokenFiles = [
            path.join(geminiDir, 'antigravity-cli', 'auth.json'),
            path.join(geminiDir, 'oauth_token.json'),
            path.join(geminiDir, 'config', 'config.json'),
        ];

        for (const tokenFile of tokenFiles) {
            if (fsSync.existsSync(tokenFile)) {
                return {
                    authenticated: true,
                    email: 'Google Antigravity OAuth',
                    method: 'oauth_token',
                };
            }
        }

        const envKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (envKey && envKey.trim()) {
            return {
                authenticated: true,
                email: 'Environment API Key',
                method: 'environment',
            };
        }

        // If binary is installed and executable, agy manages its own OAuth keychain
        if (this.checkInstalled()) {
            return {
                authenticated: true,
                email: 'Antigravity CLI User',
                method: 'native_oauth',
            };
        }

        return {
            authenticated: false,
            email: null,
            method: null,
            error: 'Antigravity CLI not configured',
        };
    }
}
