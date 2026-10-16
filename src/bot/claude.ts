import Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';

// ─────────────────────────────────────────
//  Adaptador del historial a Claude
// ─────────────────────────────────────────
// Las sesiones guardadas en bot.sessions y las herramientas de tools.ts usan el formato
// de mensajes de OpenAI. Se traducen al formato de Claude solo al llamar al modelo, así
// las conversaciones que ya existen siguen funcionando sin migrar datos.

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
type ChatToolChoice = OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;

/** Lo que el agente necesita de una respuesta: el texto y las herramientas pedidas. */
export type AssistantReply = {
    role: 'assistant';
    content: string | null;
    tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
};

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
            .map((part: any) => part.text)
            .join(' ');
    }
    return '';
}

/** Convierte una imagen `data:<mime>;base64,<datos>` en un bloque de imagen de Claude. */
function imageBlockFromDataUrl(url: string): Anthropic.ImageBlockParam | null {
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/.exec(url);
    if (!match) return null;
    return {
        type: 'image',
        source: { type: 'base64', media_type: match[1] as Anthropic.Base64ImageSource['media_type'], data: match[2] },
    };
}

function userContent(content: unknown): string | Anthropic.ContentBlockParam[] {
    if (!Array.isArray(content)) return textOf(content) || '...';
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const part of content as any[]) {
        if (part?.type === 'text' && part.text?.trim()) {
            blocks.push({ type: 'text', text: part.text });
        } else if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
            const image = imageBlockFromDataUrl(part.image_url.url);
            if (image) blocks.push(image);
        }
    }
    return blocks.length > 0 ? blocks : '...';
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Traduce el historial: los mensajes `system` van al parámetro `system`, las llamadas a
 * herramientas pasan a bloques `tool_use` y los resultados seguidos se juntan en un solo
 * mensaje del cliente con bloques `tool_result`.
 */
export function toClaudeMessages(history: ChatMessage[]): { system: string; messages: Anthropic.MessageParam[] } {
    const systemParts: string[] = [];
    const messages: Anthropic.MessageParam[] = [];

    for (const msg of history) {
        if (msg.role === 'system' || msg.role === 'developer') {
            const text = textOf(msg.content);
            if (text.trim()) systemParts.push(text);
            continue;
        }

        if (msg.role === 'user') {
            messages.push({ role: 'user', content: userContent(msg.content) });
            continue;
        }

        if (msg.role === 'assistant') {
            const blocks: Anthropic.ContentBlockParam[] = [];
            const text = textOf(msg.content);
            // Claude rechaza bloques de texto vacíos.
            if (text.trim()) blocks.push({ type: 'text', text });
            for (const call of msg.tool_calls ?? []) {
                if (call.type !== 'function') continue;
                blocks.push({
                    type: 'tool_use',
                    id: call.id,
                    name: call.function.name,
                    input: parseArguments(call.function.arguments),
                });
            }
            if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
            continue;
        }

        if (msg.role === 'tool') {
            const result: Anthropic.ToolResultBlockParam = {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: textOf(msg.content) || '{}',
            };
            const last = messages[messages.length - 1];
            const lastIsToolResults = last?.role === 'user' && Array.isArray(last.content)
                && last.content.every(block => block.type === 'tool_result');
            if (lastIsToolResults) {
                (last.content as Anthropic.ContentBlockParam[]).push(result);
            } else {
                messages.push({ role: 'user', content: [result] });
            }
        }
    }

    return { system: systemParts.join('\n\n'), messages };
}

export function toClaudeTools(tools: ChatTool[]): Anthropic.Tool[] {
    return tools
        .filter(tool => tool.type === 'function')
        .map(tool => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: (tool.function.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema,
        }));
}

export function toClaudeToolChoice(choice: ChatToolChoice | undefined): Anthropic.ToolChoice | undefined {
    if (!choice || choice === 'auto') return { type: 'auto' };
    if (choice === 'none') return { type: 'none' };
    if (choice === 'required') return { type: 'any' };
    if (choice.type === 'function') return { type: 'tool', name: choice.function.name };
    return { type: 'auto' };
}

/** Respuesta de un proveedor con formato de OpenAI → texto + tool_calls (lo mismo que guarda el historial). */
export function fromOpenAIMessage(message: OpenAI.Chat.ChatCompletionMessage | undefined): AssistantReply {
    const toolCalls = (message?.tool_calls ?? []).filter(call => call.type === 'function');
    return {
        role: 'assistant',
        content: message?.content?.trim() || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
}

/** Pasa la respuesta de Claude al formato que guarda el historial (texto + tool_calls). */
export function fromClaudeMessage(message: Anthropic.Message): AssistantReply {
    const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();

    const toolCalls = message.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map(block => ({
            id: block.id,
            type: 'function' as const,
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));

    return {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
}
