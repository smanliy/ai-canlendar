import { definePluginEntry, jsonResult } from 'openclaw/plugin-sdk/core';
const configSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        baseUrl: {
            type: 'string',
            description: 'Calendar backend base URL.'
        },
        bridgeToken: {
            type: 'string',
            description: 'Shared secret for the bridge endpoint.'
        },
        defaultUserId: {
            type: 'string',
            description: 'Fallback user ID for the current account.'
        },
        timeoutMs: {
            type: 'number',
            description: 'Bridge timeout in milliseconds.'
        }
    }
};
const toolParameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
        action: {
            type: 'string',
            enum: [
                'create_run',
                'submit_decision',
                'submit_annotation',
                'list_messages',
                'save_message',
                'clear_messages',
                'query_calendar_events'
            ]
        },
        userId: {
            type: 'string',
            description: 'Target user ID.'
        },
        runId: {
            type: 'string',
            description: 'Existing agent run ID.'
        },
        input: {
            type: 'string',
            description: 'Natural-language request for the calendar agent.'
        },
        payload: {
            type: 'object',
            additionalProperties: true
        }
    }
};
function normalizeBaseUrl(baseUrl) {
    return (baseUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
}
function resolveBridgeUrl(config) {
    return `${normalizeBaseUrl(config.baseUrl)}/api/integrations/openclaw/bridge`;
}
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function readString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function readEnvelope(value) {
    if (!isPlainObject(value))
        return {};
    return value;
}
function extractDataText(value) {
    if (typeof value === 'string')
        return value.trim();
    if (!isPlainObject(value))
        return '';
    const status = readString(value.status);
    const message = readString(value.message);
    const answer = readString(value.answer);
    const summary = readString(value.summary);
    const text = readString(value.text);
    const plans = Array.isArray(value.plans) ? value.plans : [];
    if (status === 'needsUserInput') {
        return message || '我需要你补充一些信息。';
    }
    if (status === 'llmAnswer') {
        return answer || message;
    }
    if (status === 'commandResult') {
        return [message, summary].filter(Boolean).join('\n\n') || '命令已处理。';
    }
    if (status === 'waitingConfirm') {
        if (plans.length > 0) {
            return `已生成 ${plans.length} 个方案，正在等你确认。`;
        }
        return '已生成排期结果，正在等你确认。';
    }
    return text || answer || message || summary;
}
function extractReplyText(response) {
    const envelope = readEnvelope(response);
    const data = isPlainObject(envelope.data) ? envelope.data : envelope.data;
    const direct = extractDataText(data);
    if (direct)
        return direct;
    const fallback = readString(envelope.message);
    if (fallback)
        return fallback;
    return '后端已收到，但暂时没有可回传的结果。';
}
function resolvePluginConfig(api) {
    return (api.pluginConfig ?? {});
}
async function postBridgeRequest(url, body, token, timeoutMs = 15_000, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('OpenClaw bridge request timed out')), timeoutMs);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { 'x-openclaw-bridge-token': token } : {})
            },
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`Bridge request failed: HTTP ${response.status} ${text}`);
        }
        return text ? JSON.parse(text) : {};
    }
    finally {
        clearTimeout(timer);
    }
}
function isWeixinMessage(ctx) {
    return [ctx.channel, ctx.messageProvider, ctx.channelId].some((value) => readString(value) === 'openclaw-weixin');
}
async function bridgeIncomingMessage(params) {
    const response = await postBridgeRequest(resolveBridgeUrl(params.config), {
        action: 'create_run',
        userId: params.config.defaultUserId || 'openclaw-local',
        input: params.input,
        payload: params.context ?? {}
    }, params.config.bridgeToken, params.config.timeoutMs ?? 15_000, params.signal);
    return extractReplyText(response);
}
async function bridgeToolCall(action, params, config, signal) {
    const userId = readString(params.userId) || config.defaultUserId || '';
    if (!userId && action !== 'clear_messages') {
        throw new Error('calendar_bridge: userId is required or must be configured as defaultUserId');
    }
    if (action === 'create_run' && !readString(params.input)) {
        throw new Error('calendar_bridge: input is required for create_run');
    }
    return postBridgeRequest(resolveBridgeUrl(config), {
        action,
        userId,
        runId: readString(params.runId),
        input: readString(params.input),
        payload: isPlainObject(params.payload) ? params.payload : {}
    }, config.bridgeToken, config.timeoutMs ?? 15_000, signal);
}
export default definePluginEntry({
    id: 'calendar-bridge',
    name: 'Calendar Bridge',
    description: 'Forward OpenClaw requests into the calendar backend.',
    configSchema,
    register(api) {
        const getConfig = () => resolvePluginConfig(api);
        api.registerTool({
            name: 'calendar_bridge',
            label: 'Calendar Bridge',
            description: 'Send an OpenClaw request into the calendar project backend.',
            parameters: toolParameters,
            async execute(toolCallId, params, signal) {
                void toolCallId;
                const toolParams = params;
                const config = getConfig();
                const result = await bridgeToolCall(readString(toolParams.action), toolParams, config, signal);
                return jsonResult(result);
            }
        });
        api.on('inbound_claim', async (event, ctx) => {
            if (!isWeixinMessage(ctx))
                return;
            const input = [
                readString(event.bodyForAgent),
                readString(event.body),
                readString(event.content),
                readString(event.transcript)
            ].find(Boolean);
            if (!input)
                return;
            const bridgeConfig = getConfig();
            try {
                const replyText = await bridgeIncomingMessage({
                    input,
                    config: bridgeConfig,
                    signal: undefined,
                    context: {
                        channel: event.channel,
                        channelId: ctx.channelId,
                        accountId: event.accountId ?? ctx.accountId,
                        conversationId: event.conversationId ?? ctx.conversationId,
                        sessionKey: event.sessionKey ?? ctx.sessionKey,
                        runId: event.runId ?? ctx.runId,
                        senderId: event.senderId ?? ctx.senderId,
                        messageId: event.messageId ?? ctx.messageId,
                        replyToId: event.replyToId,
                        replyToBody: event.replyToBody,
                        replyToSender: event.replyToSender,
                        replyToIsQuote: event.replyToIsQuote,
                        timestamp: event.timestamp,
                        metadata: event.metadata
                    }
                });
                return {
                    handled: true,
                    reply: { text: replyText }
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : 'bridge failed';
                return {
                    handled: true,
                    reply: { text: `Calendar Bridge 暂时不可用：${message}` }
                };
            }
        }, { priority: 100 });
        api.on('before_agent_reply', async (event, ctx) => {
            if (!isWeixinMessage(ctx))
                return;
            const input = readString(event.cleanedBody);
            if (!input)
                return;
            const bridgeConfig = getConfig();
            try {
                const replyText = await bridgeIncomingMessage({
                    input,
                    config: bridgeConfig,
                    signal: undefined,
                    context: {
                        channel: ctx.channel,
                        channelId: ctx.channelId,
                        sessionKey: ctx.sessionKey,
                        senderId: ctx.senderId,
                        conversationId: ctx.chatId,
                        runId: ctx.runId
                    }
                });
                return {
                    handled: true,
                    reply: { text: replyText }
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : 'bridge failed';
                return {
                    handled: true,
                    reply: { text: `Calendar Bridge 暂时不可用：${message}` }
                };
            }
        }, { priority: 10 });
    }
});
