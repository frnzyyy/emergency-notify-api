import 'dotenv/config';

import {
    ServerOptions,
    cli,
    defineAgent,
    voice,
    inference,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { TelephonyBackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';

if (!process.env.LIVEKIT_URL && process.env.LIVEKIT_HOST) {
    process.env.LIVEKIT_URL = process.env.LIVEKIT_HOST;
}

function safeJsonParse(text) {
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return {};
    }
}

function normalizeLine(text) {
    return String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractTextFromChatItem(item) {
    if (!item) return undefined;
    if (typeof item.textContent === 'string') return item.textContent;

    const content = item.content;
    if (!Array.isArray(content)) return undefined;

    const parts = content.filter((c) => typeof c === 'string');
    return parts.length > 0 ? parts.join('\n') : undefined;
}

function getString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function withTimeout(promise, ms, message) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timeoutId);
    }
}

export default defineAgent({
    prewarm: async (proc) => {
        proc.userData.vad = await silero.VAD.load();
    },
    entry: async (ctx) => {
        const metadata = safeJsonParse(ctx.job?.metadata);
        const targetPhoneNumber = getString(metadata.phoneNumber);
        const participantIdentity = targetPhoneNumber ? `user-${targetPhoneNumber}` : undefined;
        const roomName = getString(metadata.roomName) ?? ctx.job?.room?.name;
        const event = getString(metadata.event);
        const location = getString(metadata.location);
        const extraInstructions = getString(metadata.agentInstructions);

        const baseInstructions =
            'You are Viana Notifier, a calm and helpful emergency voice assistant. ' +
            'The user is speaking with you on a phone call. ' +
            'Ask short questions, confirm details, and keep the user safe. ' +
            'If the user is in immediate danger, tell them to contact local emergency services.';

        const contextLines = [];
        if (event) contextLines.push(`Event: ${event}`);
        if (location) contextLines.push(`Location: ${location}`);
        if (extraInstructions) contextLines.push(`Additional instructions: ${extraInstructions}`);

        const finalInstructions =
            contextLines.length > 0
                ? `${baseInstructions}\n\nCall context (use naturally, do not read verbatim):\n${contextLines.join('\n')}`
                : baseInstructions;

        await ctx.connect();

        const agent = new voice.Agent({
            instructions: finalInstructions,
        });

        const transcript = [];
        let printedTranscript = false;

        const session = new voice.AgentSession({
            // Speech-to-text (STT)
            stt: new inference.STT({ model: 'deepgram/nova-3', language: 'multi' }),
            // LLM
            llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
            // Text-to-speech (TTS)
            tts: new inference.TTS({
                model: 'cartesia/sonic-3',
                voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
            }),
            // Turn detection + VAD
            // Use VAD-based turn detection to avoid needing the LiveKit EOU turn-detector model files.
            turnDetection: 'vad',
            vad: ctx.proc.userData.vad,
        });

        session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
            if (!ev?.isFinal) return;
            const line = normalizeLine(ev.transcript);
            if (!line) return;
            transcript.push({ role: 'user', text: line, createdAt: ev.createdAt ?? Date.now() });
        });

        session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
            const item = ev?.item;
            if (!item || item.type !== 'message' || item.role !== 'assistant') return;

            const line = normalizeLine(extractTextFromChatItem(item));
            if (!line) return;
            transcript.push({
                role: 'assistant',
                text: line,
                createdAt: item.createdAt ?? ev.createdAt ?? Date.now(),
            });
        });

        session.on(voice.AgentSessionEventTypes.Close, (ev) => {
            if (printedTranscript) return;
            printedTranscript = true;

            const sorted = transcript
                .slice()
                .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

            console.log('\n================ CALL TRANSCRIPT ================');
            if (roomName) console.log(`Room: ${roomName}`);
            if (targetPhoneNumber) console.log(`Phone: ${targetPhoneNumber}`);
            if (ev?.reason) console.log(`Close reason: ${ev.reason}`);
            console.log('-------------------------------------------------');

            if (sorted.length === 0) {
                console.log('(no transcript captured)');
            } else {
                for (const line of sorted) {
                    console.log(`${line.role === 'assistant' ? 'AI' : 'User'}: ${line.text}`);
                }
            }

            console.log('================ END TRANSCRIPT =================\n');
        });

        await session.start({
            agent,
            room: ctx.room,
            inputOptions: {
                noiseCancellation: TelephonyBackgroundVoiceCancellation(),
                participantIdentity,
            },
        });

        try {
            if (participantIdentity) {
                await withTimeout(
                    ctx.waitForParticipant(participantIdentity),
                    60_000,
                    `Timed out waiting for participant ${participantIdentity}`,
                );
            } else {
                await withTimeout(ctx.waitForParticipant(), 60_000, 'Timed out waiting for participant');
            }
        } catch (error) {
            console.warn('No participant joined; shutting down job.', error);
            ctx.shutdown('participant_wait_timeout');
            return;
        }

        await session.generateReply({
            instructions:
                event || location
                    ? `Greet the user. Briefly say you're calling about: ${[event, location].filter(Boolean).join(' - ')}. Ask if they can hear you and if they are safe.`
                    : 'Greet the user and ask if they can hear you and if they are safe.',
        });
    },
});

cli.runApp(
    new ServerOptions({
        agent: fileURLToPath(import.meta.url),
        agentName: process.env.LIVEKIT_AGENT_NAME ?? 'viana-agent',
    }),
);
