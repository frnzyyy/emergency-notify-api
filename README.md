# LiveKit Emergency Alert Agent

An automated emergency alert assistant built on [LiveKit Agents](https://docs.livekit.io/agents/). When an alert is triggered, this service places an outbound call to a person, connects them to an AI voice assistant, and walks them through a short safety conversation.

## How it works

1. A caller (your backend, or the manual CLI) requests an alert call through `makeEmergencyAlertCall()`.
2. The service creates a LiveKit room, dispatches the AI voice agent to it, and dials the target phone number via a LiveKit SIP trunk.
3. The voice agent joins the room once the person picks up, greets them with call context (event/location), and has a spoken conversation.
4. When the call ends, the full transcript is printed to the agent's logs.

The agent uses:

- **STT:** Deepgram Nova-3 (multi-language)
- **LLM:** OpenAI GPT-4.1-mini
- **TTS:** Cartesia Sonic-3
- **Turn detection:** Silero VAD (no external EOU model files needed)
- **Noise cancellation:** Telephony background noise cancellation (via `@livekit/noise-cancellation-node`)

## Repository layout

| Path                    | Purpose                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `agent-server.mjs`      | The voice agent (runs on LiveKit Cloud / workers). Defines the `entry` worker, agent session, and transcript logging. |
| `livekit-agent.mjs`     | Client that places the call: creates the room, dispatches the agent, and dials via SIP. Exposes `makeEmergencyAlertCall()`. |
| `livekit.toml`          | LiveKit Cloud project / agent identifiers. **Do not rename.**           |
| `Dockerfile`            | Docker image for the agent worker (production).                         |
| `KMS/logs/`             | Local directory reserved for runtime logs.                              |
| `.env`                  | Environment configuration (see below). Not committed to git.           |

## Prerequisites

- Node.js 22+
- A [LiveKit Cloud](https://cloud.livekit.io/) project
- A SIP trunk configured with at least one phone number to call from
- API keys for the inference models used by the agent (Deepgram, OpenAI, Cartesia) provisioned on the LiveKit Cloud agent deployment

## Installation

```bash
npm install
```

## Environment variables

Create a `.env` file in the project root. See `.env.example`-style defaults below; copy the shape from your LiveKit Cloud **Settings > Keys**.

| Variable                          | Required | Description                                                   |
| --------------------------------- | -------- | ------------------------------------------------------------- |
| `LIVEKIT_URL`                     | Yes      | LiveKit Cloud WebSocket URL (e.g. `wss://<project>.livekit.cloud`). `LIVEKIT_HOST` is accepted as an alias. |
| `LIVEKIT_API_KEY`                 | Yes      | LiveKit API key.                                              |
| `LIVEKIT_API_SECRET`              | Yes      | LiveKit API secret.                                           |
| `LIVEKIT_SIP_TRUNK_ID`            | No       | SIP trunk used for outbound calls. Defaults to a hardcoded trunk ID. |
| `LIVEKIT_AGENT_NAME`              | No       | Agent name registered on LiveKit Cloud. Defaults to `emergency-alert-agent`. |
| `EMERGENCY_TEST_PHONE_NUMBER`     | No       | Default phone number for manual test calls.                   |
| `EMERGENCY_TEST_ROOM_NAME`        | No       | Default room name for manual test calls.                      |
| `EMERGENCY_EVENT`                 | No       | Event context for manual calls (e.g. `storm warning`).        |
| `EMERGENCY_LOCATION`              | No       | Location context for manual calls.                            |
| `EMERGENCY_AGENT_INSTRUCTIONS`    | No       | Extra instructions for the AI assistant on manual calls.      |

> **Security note:** never commit `.env` to source control. It is already in `.gitignore`.

## Usage

### Run the agent worker (production)

```bash
npm start
```

This starts `agent-server.mjs start`, which registers the agent to wait for jobs dispatched from LiveKit Cloud (typically run inside the Docker image).

### Run the agent in dev mode

```bash
npm run agent:dev
```

### Place a test call

```bash
npm run call -- +639123456789
```

Or pass a room name explicitly:

```bash
npm run call -- +639123456789 my-room
```

With no arguments, the CLI falls back to `EMERGENCY_TEST_PHONE_NUMBER` / `EMERGENCY_TEST_ROOM_NAME` from `.env`.

You can also call the function programmatically:

```js
import { makeEmergencyAlertCall } from "./livekit-agent.mjs";

await makeEmergencyAlertCall({
  phoneNumber: "+639123456789",
  event: "storm warning",
  location: "Apartment 12B, Maple Street",
  agentInstructions: "Remind them to charge their phone.",
});
```

### Pre-download plugin files

```bash
npm run download-files
```

## Deployment

The included `Dockerfile` follows the standard LiveKit Agents image pattern (Node 22 slim, non-root user, `npm ci`, plugin files pre-downloaded, production mode by default):

```bash
docker build -t livekit-emergency-alert-agent .
docker run --env-file .env livekit-emergency-alert-agent
```

Deploy this image as the worker for your **`emergency-alert-agent`** deployment on LiveKit Cloud. Capacity may need tuning for concurrency; each call runs one agent job.

## Call metadata

When you call `makeEmergencyAlertCall()`, the following metadata is passed to the agent and used to shape the conversation:

| Field               | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `phoneNumber`       | Used to derive the participant identity (`user-<phone>`). |
| `roomName`          | Room label; generated (`alert-<uuid>`) if omitted.   |
| `event`             | Describes what happened.                             |
| `location`          | Where it happened.                                   |
| `agentInstructions` | Additional guidance for the assistant.               |

## Notes

- `livekit.toml` links this repo to your LiveKit Cloud project and agent. Do not rename the `subdomain` or `agent.id` values unless you are intentionally re-provisioning a new project.
- If no participant answers within 60 seconds, the job shuts down with `participant_wait_timeout`.
- Agent dispatch failures are non-fatal log warnings; the SIP call continues regardless.