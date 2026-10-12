/**
 * A tool call refused by o8 with a fixed message of its own (#3556). Its text
 * reaches the model so it can correct the call; any other host error reaches
 * the model as generic text, since it can carry paths or provider bodies.
 */
export class PiToolRefusal extends Error {}

/** JSON-RPC error code that carries a `PiToolRefusal` message to the worker. */
export const PI_TOOL_REFUSAL_CODE = -32002;
