export class ActionPluginError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
