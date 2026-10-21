interface WritableTerminal {
  options: { disableStdin?: boolean };
  reset?: () => void;
  write: (data: string | Uint8Array, callback?: () => void) => void;
}

interface OutputWrite {
  data: string | Uint8Array;
  historical: boolean;
  reset?: boolean;
  callback?: () => void;
}

interface OutputState {
  queue: OutputWrite[];
  writing: boolean;
  historical: boolean;
  inputDisabled: boolean;
  disposed: boolean;
}

const states = new WeakMap<WritableTerminal, OutputState>();

function stateFor(term: WritableTerminal): OutputState {
  let state = states.get(term);
  if (!state) {
    state = { queue: [], writing: false, historical: false, inputDisabled: Boolean(term.options.disableStdin), disposed: false };
    states.set(term, state);
  }
  return state;
}

function applyInputState(term: WritableTerminal, state: OutputState): void {
  if (!state.disposed) term.options.disableStdin = state.inputDisabled || state.historical;
}

function flush(term: WritableTerminal, state: OutputState): void {
  if (state.disposed || state.writing) return;
  const next = state.queue.shift();
  if (!next) return;
  state.writing = true;
  state.historical = next.historical;
  applyInputState(term, state);
  let completed = false;
  try {
    if (next.reset) { term.reset?.(); applyInputState(term, state); }
    term.write(next.data, () => {
      if (completed || state.disposed) return;
      completed = true;
      state.writing = false;
      state.historical = false;
      applyInputState(term, state);
      try { next.callback?.(); } finally { flush(term, state); }
    });
  } catch (error) {
    state.writing = false;
    state.historical = false;
    state.queue = [];
    applyInputState(term, state);
    throw error;
  }
}

/** Keep the replay flag attached until xterm finishes parsing that exact write. */
export function writeTerminalOutput(
  term: WritableTerminal, data: string | Uint8Array, callback?: () => void, historical = false,
): void {
  const state = stateFor(term);
  if (state.disposed) return;
  state.queue.push({ data, callback, historical });
  flush(term, state);
}

/** Reset only after earlier output has parsed, before the authoritative snapshot. */
export function resetTerminalOutput(term: WritableTerminal, data: string | Uint8Array, callback?: () => void): void {
  const state = stateFor(term);
  if (state.disposed) return;
  state.queue.push({ data, callback, historical: true, reset: true });
  flush(term, state);
}

/** A replay callback must not undo a newer read-only, lock or exit decision. */
export function setTerminalInputDisabled(term: WritableTerminal, disabled: boolean): void {
  const state = stateFor(term);
  state.inputDisabled = disabled;
  applyInputState(term, state);
}

export function disposeTerminalOutput(term: WritableTerminal): void {
  const state = states.get(term);
  if (!state) return;
  state.disposed = true;
  state.queue = [];
}
