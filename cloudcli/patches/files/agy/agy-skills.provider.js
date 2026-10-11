import os from 'node:os';
import path from 'node:path';
import { SkillsProvider } from '../../../../modules/providers/shared/skills/skills.provider.js';
import { addUniqueProviderSkillSource, findTopmostGitRoot } from '../../../../shared/utils.js';

const AGY_PROJECT_SKILL_DIRS = [
    ['.gemini', 'skills'],
    ['.agents', 'skills'],
    ['skills'],
];

const AGY_USER_SKILL_DIRS = [
    ['.gemini', 'config', 'skills'],
    ['.gemini', 'antigravity-cli', 'builtin', 'skills'],
];

export class AgySkillsProvider extends SkillsProvider {
    constructor() {
        super('agy');
    }

    async getSkillSources(workspacePath) {
        const sources = [];
        const seenRootDirs = new Set();
        const repoRoot = await findTopmostGitRoot(workspacePath);

        const searchRoots = [workspacePath];
        if (repoRoot && repoRoot !== workspacePath) {
            searchRoots.push(repoRoot);
        }

        for (const projectRoot of searchRoots) {
            for (const skillDir of AGY_PROJECT_SKILL_DIRS) {
                addUniqueProviderSkillSource(sources, seenRootDirs, {
                    scope: 'project',
                    rootDir: path.join(projectRoot, ...skillDir),
                    commandPrefix: '/',
                });
            }
        }

        for (const skillDir of AGY_USER_SKILL_DIRS) {
            addUniqueProviderSkillSource(sources, seenRootDirs, {
                scope: 'user',
                rootDir: path.join(os.homedir(), ...skillDir),
                commandPrefix: '/',
            });
        }

        return sources;
    }
}
