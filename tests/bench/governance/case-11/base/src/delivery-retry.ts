export interface OneTimeToken {
  value: string;
}

export interface TokenIssuer {
  issue(): OneTimeToken;
}

export interface DeliveryTransport {
  send(payload: string, token: OneTimeToken): Promise<void>;
}

export async function deliver(
  payload: string,
  issuer: TokenIssuer,
  transport: DeliveryTransport,
): Promise<void> {
  await transport.send(payload, issuer.issue());
}
