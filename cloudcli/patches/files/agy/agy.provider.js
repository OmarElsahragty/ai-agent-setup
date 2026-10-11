import { AgyProviderAuth } from './agy-auth.provider.js';
import { AgyProviderModels } from './agy-models.provider.js';
import { agyRuntime } from './agy-runtime.provider.js';
import { AgyMcpProvider } from './agy-mcp.provider.js';
import { AgySessionSynchronizer } from './agy-session-synchronizer.provider.js';
import { AgySessionsProvider } from './agy-sessions.provider.js';
import { AgySkillsProvider } from './agy-skills.provider.js';
import { AbstractProvider } from '../../../../modules/providers/shared/base/abstract.provider.js';

export class AgyProvider extends AbstractProvider {
    runtime = agyRuntime;
    models = new AgyProviderModels();
    mcp = new AgyMcpProvider();
    auth = new AgyProviderAuth();
    skills = new AgySkillsProvider();
    sessions = new AgySessionsProvider();
    sessionSynchronizer = new AgySessionSynchronizer();

    constructor() {
        super('agy');
    }
}
