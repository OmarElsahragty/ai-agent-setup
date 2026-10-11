import { sessionsDb } from '../../../../modules/database/index.js';
import { buildDefaultProviderCurrentActiveModel } from '../../../../shared/utils.js';

export const AGY_PREDEFINED_MODELS = {
    DEFAULT: 'gemini-3.8-flash-high',
    OPTIONS: [
        {
            value: 'gemini-3.8-flash-high',
            label: 'Gemini 3.8 Flash (High)',
            description: 'Latest Google Gemini 3.8 Flash with high reasoning effort',
            effort: {
                values: [
                    { value: 'low' },
                    { value: 'medium' },
                    { value: 'high' },
                    { value: 'xhigh' },
                    { value: 'max' },
                ],
            },
        },
        {
            value: 'gemini-3.8-flash-medium',
            label: 'Gemini 3.8 Flash (Medium)',
            description: 'Google Gemini 3.8 Flash with medium reasoning effort',
        },
        {
            value: 'gemini-3.8-flash-low',
            label: 'Gemini 3.8 Flash (Low)',
            description: 'Google Gemini 3.8 Flash with low reasoning effort',
        },
        {
            value: 'gemini-3.7-flash-high',
            label: 'Gemini 3.7 Flash (High)',
            description: 'Google Gemini 3.7 Flash with high reasoning effort',
            effort: {
                values: [
                    { value: 'low' },
                    { value: 'medium' },
                    { value: 'high' },
                    { value: 'xhigh' },
                    { value: 'max' },
                ],
            },
        },
        {
            value: 'gemini-3.7-flash-medium',
            label: 'Gemini 3.7 Flash (Medium)',
            description: 'Google Gemini 3.7 Flash with medium reasoning effort',
        },
        {
            value: 'gemini-3.7-flash-low',
            label: 'Gemini 3.7 Flash (Low)',
            description: 'Google Gemini 3.7 Flash with low reasoning effort',
        },
        {
            value: 'gemini-3.6-flash-high',
            label: 'Gemini 3.6 Flash (High)',
            description: 'Google Gemini 3.6 Flash (High reasoning)',
        },
        {
            value: 'gemini-3.1-pro-high',
            label: 'Gemini 3.1 Pro (High)',
            description: 'Google Gemini 3.1 Pro (High reasoning)',
        },
        {
            value: 'claude-sonnet-4-6',
            label: 'Claude Sonnet 4.6 (Thinking)',
            description: 'Anthropic Claude Sonnet with extended thinking via agy',
        },
        {
            value: 'claude-opus-4-6-thinking',
            label: 'Claude Opus 4.6 (Thinking)',
            description: 'Anthropic Claude Opus with extended thinking via agy',
        },
        {
            value: 'gpt-oss-120b-medium',
            label: 'GPT-OSS 120B (Medium)',
            description: 'Open weight 120B model (Medium effort)',
        },
    ],
};

export class AgyProviderModels {
    async getSupportedModels() {
        return AGY_PREDEFINED_MODELS;
    }

    async getCurrentActiveModel(sessionId) {
        if (!sessionId?.trim()) {
            return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
        }
        const session = sessionsDb.getSessionById(sessionId);
        if (session?.model) {
            return {
                model: session.model,
                effort: session.effort || undefined,
            };
        }
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
}
