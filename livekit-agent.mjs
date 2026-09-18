import { AgentDispatchClient, RoomServiceClient, SipClient } from "livekit-server-sdk";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

// 1. Initialize the LiveKit Client
// Grab these from your LiveKit Cloud Dashboard (Settings > Keys)
const livekitHost = process.env.LIVEKIT_URL ?? process.env.LIVEKIT_HOST;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const sipTrunkId = process.env.LIVEKIT_SIP_TRUNK_ID ?? "ST_aGmdBjNU9gWf";

if (!livekitHost)
  throw new Error("Missing LIVEKIT_URL (or LIVEKIT_HOST) (check .env)");
if (!apiKey) throw new Error("Missing LIVEKIT_API_KEY (check .env)");
if (!apiSecret) throw new Error("Missing LIVEKIT_API_SECRET (check .env)");
if (!process.env.LIVEKIT_SIP_TRUNK_ID) {
  console.warn(
    "LIVEKIT_SIP_TRUNK_ID is not set; using the default trunk ID. Set LIVEKIT_SIP_TRUNK_ID in .env for production.",
  );
}

const roomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);
const sipClient = new SipClient(livekitHost, apiKey, apiSecret);
const agentDispatchClient = new AgentDispatchClient(
  livekitHost,
  apiKey,
  apiSecret,
);

function isE164PhoneNumber(value) {
  return typeof value === "string" && /^\+[1-9]\d{6,14}$/.test(value);
}

// ----------------------------------------------------------------------------
// MAIN ACTION: PLACE THE ALERT CALL
// ----------------------------------------------------------------------------

/**
 * Dials a person and connects them to the AI emergency alert assistant.
 *
 * @param {object} options
 * @param {string} options.phoneNumber        The person to call, e.g. "+639123456789".
 * @param {string} [options.roomName]         A label for this call (optional; one will be made up).
 * @param {string} [options.event]            What happened, e.g. "storm warning".
 * @param {string} [options.location]         Where it happened, e.g. "Apartment 12B, Maple Street".
 * @param {string} [options.agentInstructions] Optional extra guidance for the AI assistant.
 */
export async function makeEmergencyAlertCall({
  phoneNumber,
  roomName,
  event,
  location,
  agentInstructions,
} = {}) {
  if (!isE164PhoneNumber(phoneNumber)) {
    throw new Error(
      `Invalid phoneNumber "${phoneNumber}". Expected E.164 like +639XXXXXXXXX`,
    );
  }

  if (!roomName) {
    roomName = `alert-${randomUUID()}`;
  }

  console.log(`Initiating outbound call to ${phoneNumber} (room: ${roomName})...`);

  try {
    // 2. Ensure the room exists (so we can control timeouts/limits).
    try {
      await roomService.createRoom({
        name: roomName,
        emptyTimeout: 60,
        departureTimeout: 60,
        maxParticipants: 4,
        metadata: JSON.stringify({ event, location }),
      });
    } catch (error) {
      const code = error?.code;
      const status = error?.status;
      const msg = String(error?.message ?? error);
      const alreadyExists =
        code === "already_exists" ||
        status === 409 ||
        msg.toLowerCase().includes("already exists");
      if (!alreadyExists) throw error;
    }

    // 2. Dispatch the voice agent (best-effort). The call will be silent until an agent (or other participant)
    // joins the room and publishes audio.
    const agentName = process.env.LIVEKIT_AGENT_NAME ?? "emergency-alert-agent";

    try {
      await agentDispatchClient.createDispatch(roomName, agentName, {
        metadata: JSON.stringify({
          phoneNumber,
          roomName,
          agentInstructions,
          event,
          location,
        }),
      });
    } catch (error) {
      console.warn(
        `Agent dispatch failed (agentName="${agentName}"). Continuing call anyway.`,
        error,
      );
    }

    // 2. Dial out via LiveKit SIP
    const sipParticipant = await sipClient.createSipParticipant(
      sipTrunkId,
      phoneNumber,
      roomName,
      {
        participantIdentity: `user-${phoneNumber}`,
        participantName: "Emergency Alert Recipient",
      },
    );

    console.log("Call successfully handed off to the phone provider!", sipParticipant);
    return sipParticipant;
  } catch (error) {
    console.error("Failed to initiate SIP call:", error);
    throw error;
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [phoneArg, roomArg] = process.argv.slice(2);
  const phoneNumber = phoneArg ?? process.env.EMERGENCY_TEST_PHONE_NUMBER;
  const roomName = roomArg ?? process.env.EMERGENCY_TEST_ROOM_NAME;

  if (!phoneNumber) {
    console.error("Usage: npm run call -- <phoneNumber> [roomName]");
    console.error("Tip: set EMERGENCY_TEST_PHONE_NUMBER in .env for a default.");
    process.exitCode = 1;
  } else {
    makeEmergencyAlertCall({
      phoneNumber,
      roomName,
      event: process.env.EMERGENCY_EVENT,
      location: process.env.EMERGENCY_LOCATION,
      agentInstructions: process.env.EMERGENCY_AGENT_INSTRUCTIONS,
    }).catch((error) => {
      console.error("Unhandled error:", error);
      process.exitCode = 1;
    });
  }
}
