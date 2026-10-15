import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex } from "./protocol.js";

/**
 * Ed25519 challenge-response verification machinery (issue #31 cycle 3).
 *
 * Why this exists: V3 DM frames carry only a 6-byte pubkey prefix, and the
 * SignedPlain 4-byte prefix is not a verifiable signature (see issue #31
 * recon 2026-10-10) — so inbound DM identity is convenience-grade. A real
 * cryptographic proof IS possible out-of-band: the companion protocol is a
 * signing oracle (CMD_DEVICE_SIGN), and the contact book's full pubkeys are
 * transitively firmware-advert-verified. This module is the verifier half
 * of that protocol: given a challenge WE issued and a signature over it,
 * verify the signature against the responder's full pubkey.
 *
 * The request half (asking a peer to sign) needs a signing-capable peer;
 * companion clients cannot sign and room servers are the only signing class
 * today (issue #31, 2026-10-11), so this machinery is intentionally not
 * wired into the inbound DM path yet. It is proven by known-answer tests
 * and by the signing-oracle self-test (tools probe) against our own node.
 */

export const ED25519_PUBLIC_KEY_LENGTH = 32;
export const ED25519_SIGNATURE_LENGTH = 64;
export const CHALLENGE_NONCE_LENGTH = 16;

/**
 * Verify an Ed25519 signature. Length-guarded and exception-safe: noble
 * throws on malformed points/scalars, which for a verifier is simply a
 * failed verification.
 */
export function verifyEd25519Signature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (
    publicKey.length !== ED25519_PUBLIC_KEY_LENGTH ||
    signature.length !== ED25519_SIGNATURE_LENGTH
  ) {
    return false;
  }
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

const CHALLENGE_DOMAIN = "meshcore-tier3-challenge/v1";

/** Freshness window for a challenge answer (±10 min, covers clock skew). */
export const CHALLENGE_FRESHNESS_MS = 10 * 60 * 1000;

export type Tier3Challenge = {
  /** 16 random bytes, hex-encoded. Single-use; the verifier stores it. */
  nonceHex: string;
  /** Verifier-side clock when the challenge was issued (epoch ms). */
  issuedAtMs: number;
  /**
   * The verifier's own full pubkey. Bound into the signed message so an
   * answer produced for someone else's challenge cannot be replayed to us.
   */
  verifierPubkey: Uint8Array;
};

/** Create a fresh single-use challenge. The caller persists it until answered. */
export function generateChallenge(
  verifierPubkey: Uint8Array,
  nowMs: number = Date.now(),
): Tier3Challenge {
  return {
    nonceHex: randomBytes(CHALLENGE_NONCE_LENGTH).toString("hex"),
    issuedAtMs: nowMs,
    verifierPubkey,
  };
}

/**
 * Canonical message bytes the responder signs. Rebuilt verifier-side from the
 * STORED challenge — never accept a challenge string from the wire, or a
 * responder could substitute a weaker message of its own choosing.
 */
export function buildChallengeMessage(challenge: Tier3Challenge): Uint8Array {
  const body = [
    CHALLENGE_DOMAIN,
    challenge.nonceHex,
    String(challenge.issuedAtMs),
    bytesToHex(challenge.verifierPubkey).toLowerCase(),
  ].join("\n");
  return new TextEncoder().encode(body);
}

export type ChallengeVerification =
  | { ok: true }
  | { ok: false; reason: "stale" | "future" | "bad-signature" };

/**
 * Verify a challenge answer against the responder's full pubkey (sourced from
 * the firmware-advert-verified contact book) and the stored challenge.
 */
export function verifyChallengeResponse(params: {
  challenge: Tier3Challenge;
  responderPubkey: Uint8Array;
  signature: Uint8Array;
  nowMs?: number;
}): ChallengeVerification {
  const nowMs = params.nowMs ?? Date.now();
  const age = nowMs - params.challenge.issuedAtMs;
  if (age > CHALLENGE_FRESHNESS_MS) {
    return { ok: false, reason: "stale" };
  }
  if (age < -CHALLENGE_FRESHNESS_MS) {
    return { ok: false, reason: "future" };
  }
  const message = buildChallengeMessage(params.challenge);
  return verifyEd25519Signature(params.responderPubkey, message, params.signature)
    ? { ok: true }
    : { ok: false, reason: "bad-signature" };
}

/** @internal Test helper: derive the public key for a test secret key. */
export function _testOnlyPublicKey(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}

/** @internal Test helper: sign a message (the peer/oracle role in KATs). */
export function _testOnlySign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

