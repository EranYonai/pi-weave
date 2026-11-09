import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { StoredPasskey } from "./auth";

/**
 * Passkey ceremonies, the same settings Hearthside uses: a discoverable key
 * made on this device, user verification (Face ID, Touch ID or the device
 * PIN) required on every use, no attestation. The server keeps only the public
 * key; the private half never leaves the phone's secure hardware or the
 * person's passkey manager.
 *
 * Behind an interface so the server's tests can drive sign-in without a real
 * authenticator. `simpleWebAuthn` is the one implementation the app runs.
 */
export interface PasskeyRelyingParty {
  origin: string;
  rpId: string;
}

export interface WebAuthn {
  registrationOptions(
    rp: PasskeyRelyingParty,
    user: { id: string; name: string },
    existing: readonly StoredPasskey[],
  ): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(
    rp: PasskeyRelyingParty,
    response: RegistrationResponseJSON,
    challenge: string,
  ): Promise<Omit<StoredPasskey, "name" | "created" | "lastUsed"> | null>;
  authenticationOptions(rp: PasskeyRelyingParty): Promise<PublicKeyCredentialRequestOptionsJSON>;
  /** The new signature counter, or null when the response does not verify. */
  verifyAuthentication(
    rp: PasskeyRelyingParty,
    response: AuthenticationResponseJSON,
    challenge: string,
    passkey: StoredPasskey,
  ): Promise<number | null>;
}

export type { AuthenticationResponseJSON, RegistrationResponseJSON };

export const simpleWebAuthn: WebAuthn = {
  registrationOptions(rp, user, existing) {
    return generateRegistrationOptions({
      rpName: "Weave Capture",
      rpID: rp.rpId,
      userName: user.name,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      // Save the passkey on this device (iCloud Keychain, Google Password Manager).
      // Without it, an iPhone can jump straight to the "use another device" QR code.
      preferredAuthenticatorType: "localDevice",
      excludeCredentials: existing.map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      })),
    });
  },

  async verifyRegistration(rp, response, challenge) {
    try {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo) return null;
      const { credential } = result.registrationInfo;
      return {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports ?? response.response.transports ?? [],
      };
    } catch {
      return null;
    }
  },

  authenticationOptions(rp) {
    // No allowCredentials: the browser offers whatever passkey it holds for this
    // site, so the sign-in page never needs to know who is signing in.
    return generateAuthenticationOptions({ rpID: rp.rpId, userVerification: "required" });
  },

  async verifyAuthentication(rp, response, challenge, passkey) {
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")),
          counter: passkey.counter,
          transports: passkey.transports as AuthenticatorTransportFuture[],
        },
      });
      return result.verified ? result.authenticationInfo.newCounter : null;
    } catch {
      return null;
    }
  },
};
