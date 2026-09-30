export interface UpdaterSignatureIdentity {
  algorithm: 'ED' | 'Ed';
  artifactSha256: string;
  signatureSha256: string;
}

export function loadUpdaterPublicKey(root: string): {
  keyId: Buffer;
  publicKey: Buffer;
};

export function verifyUpdaterSignature(
  root: string,
  artifactPath: string,
  signaturePath: string,
): UpdaterSignatureIdentity;
