import { describe, expect, it } from "vitest";
import { hexToBytes } from "./protocol.js";
import {
  buildChallengeMessage,
  generateChallenge,
  verifyChallengeResponse,
  verifyEd25519Signature,
  _testOnlyPublicKey,
  _testOnlySign,
  CHALLENGE_FRESHNESS_MS,
  type Tier3Challenge,
} from "./signature-verify.js";

describe("verifyEd25519Signature (#31 cycle 3)", () => {
  // Pinned known-answer vector (Ed25519 is deterministic, RFC 8032):
  // secret key = 32 x 0x07, message = "kat".
  const KAT_PUBKEY = hexToBytes(
    "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c",
  );
  const KAT_MESSAGE = new TextEncoder().encode("kat");
  const KAT_SIGNATURE = hexToBytes(
    "fe70f7dbe1bd00d672d85793d0e3a6d263b15fe207fd9ed0b59fb83ef49b5d0a86ca70b2b1df7f4a086c02aa7277af7be4287b1520efc355595ea7e976b0c00a",
  );

  it("verifies the pinned known-answer vector", () => {
    expect(verifyEd25519Signature(KAT_PUBKEY, KAT_MESSAGE, KAT_SIGNATURE)).toBe(true);
  });

  it("rejects with a different public key", () => {
    const otherKey = _testOnlyPublicKey(new Uint8Array(32).fill(9));
    expect(verifyEd25519Signature(otherKey, KAT_MESSAGE, KAT_SIGNATURE)).toBe(false);
  });

  it("rejects with a tampered message", () => {
    const tampered = new TextEncoder().encode("kaX");
    expect(verifyEd25519Signature(KAT_PUBKEY, tampered, KAT_SIGNATURE)).toBe(false);
  });

  it("rejects with a tampered signature byte", () => {
    const tampered = new Uint8Array(KAT_SIGNATURE);
    tampered[10] ^= 0xff;
    expect(verifyEd25519Signature(KAT_PUBKEY, KAT_MESSAGE, tampered)).toBe(false);
  });

  it("rejects wrong lengths without throwing", () => {
    expect(
      verifyEd25519Signature(KAT_PUBKEY.subarray(0, 31), KAT_MESSAGE, KAT_SIGNATURE),
    ).toBe(false);
    expect(
      verifyEd25519Signature(KAT_PUBKEY, KAT_MESSAGE, KAT_SIGNATURE.subarray(0, 63)),
    ).toBe(false);
    expect(
      verifyEd25519Signature(KAT_PUBKEY, KAT_MESSAGE, new Uint8Array(65)),
    ).toBe(false);
  });

  it("rejects garbage that makes noble throw, without throwing", () => {
    // All-ones signature is not a valid point encoding; must fail closed.
    expect(
      verifyEd25519Signature(KAT_PUBKEY, KAT_MESSAGE, new Uint8Array(64).fill(0xff)),
    ).toBe(false);
  });

  it("verifies a signature over an empty message", () => {
    const secretKey = new Uint8Array(32).fill(3);
    const publicKey = _testOnlyPublicKey(secretKey);
    const message = new Uint8Array(0);
    const signature = _testOnlySign(message, secretKey);
    expect(verifyEd25519Signature(publicKey, message, signature)).toBe(true);
  });
});

describe("tier-3 challenge-response (#31 cycle 3)", () => {
  const verifierSecret = new Uint8Array(32).fill(0xa1);
  const responderSecret = new Uint8Array(32).fill(0xb2);
  const verifierPubkey = _testOnlyPublicKey(verifierSecret);
  const responderPubkey = _testOnlyPublicKey(responderSecret);

  function answerChallenge(challenge: Tier3Challenge): Uint8Array {
    return _testOnlySign(buildChallengeMessage(challenge), responderSecret);
  }

  it("accepts a fresh, correctly signed answer", () => {
    const challenge = generateChallenge(verifierPubkey, 1_000_000);
    const signature = answerChallenge(challenge);
    expect(
      verifyChallengeResponse({
        challenge,
        responderPubkey,
        signature,
        nowMs: 1_000_000 + 60_000,
      }),
    ).toEqual({ ok: true });
  });

  it("challenges are single-use random (two generations differ)", () => {
    const a = generateChallenge(verifierPubkey);
    const b = generateChallenge(verifierPubkey);
    expect(a.nonceHex).not.toBe(b.nonceHex);
  });

  it("rejects a stale answer", () => {
    const challenge = generateChallenge(verifierPubkey, 1_000_000);
    const signature = answerChallenge(challenge);
    expect(
      verifyChallengeResponse({
        challenge,
        responderPubkey,
        signature,
        nowMs: 1_000_000 + CHALLENGE_FRESHNESS_MS + 1,
      }),
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects an answer from the far future", () => {
    const challenge = generateChallenge(verifierPubkey, 10_000_000);
    const signature = answerChallenge(challenge);
    expect(
      verifyChallengeResponse({
        challenge,
        responderPubkey,
        signature,
        nowMs: 10_000_000 - CHALLENGE_FRESHNESS_MS - 1,
      }),
    ).toEqual({ ok: false, reason: "future" });
  });

  it("rejects an answer signed by the wrong responder key", () => {
    const challenge = generateChallenge(verifierPubkey, 1_000_000);
    const wrongSignature = _testOnlySign(
      buildChallengeMessage(challenge),
      new Uint8Array(32).fill(0xc3),
    );
    expect(
      verifyChallengeResponse({ challenge, responderPubkey, signature: wrongSignature, nowMs: 1_000_000 }),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("verifier binding: an answer produced for a different verifier is rejected", () => {
    const challenge = generateChallenge(verifierPubkey, 1_000_000);
    // Attacker replays a signature the responder produced for a DIFFERENT
    // verifier's challenge (different verifierPubkey in the signed message).
    const foreignChallenge: Tier3Challenge = {
      ...challenge,
      verifierPubkey: _testOnlyPublicKey(new Uint8Array(32).fill(0xd4)),
    };
    const foreignSignature = _testOnlySign(
      buildChallengeMessage(foreignChallenge),
      responderSecret,
    );
    expect(
      verifyChallengeResponse({ challenge, responderPubkey, signature: foreignSignature, nowMs: 1_000_000 }),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("challenge message pins its canonical layout", () => {
    const challenge: Tier3Challenge = {
      nonceHex: "00112233445566778899aabbccddeeff",
      issuedAtMs: 1_760_000_000_000,
      verifierPubkey: new Uint8Array(32).fill(0x11),
    };
    const message = new TextDecoder().decode(buildChallengeMessage(challenge));
    expect(message).toBe(
      "meshcore-tier3-challenge/v1\n" +
        "00112233445566778899aabbccddeeff\n" +
        "1760000000000\n" +
        "1111111111111111111111111111111111111111111111111111111111111111",
    );
  });
});
