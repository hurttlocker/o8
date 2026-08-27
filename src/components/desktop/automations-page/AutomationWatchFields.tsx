'use client';

import type { AutomationFormState } from './types';
import { Field, InlinePicker, inputStyle, MONO_FONT } from './AutomationEditorControls';

export function AutomationWatchFields({
  form,
  update,
}: {
  form: AutomationFormState;
  update: (patch: Partial<AutomationFormState>) => void;
}) {
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        <Field label="Watch source">
          <InlinePicker
            value={form.watchSourceKind}
            options={[
              { value: 'managed_run', label: 'Managed run', detail: 'Output, exit, loss, quiet, and recovery.' },
              { value: 'packet', label: 'Packet or mission', detail: 'Durable lane and packet state transitions.' },
              { value: 'repository', label: 'Repository', detail: 'Pull request and check updates.' },
            ]}
            onChange={(watchSourceKind) => update({ watchSourceKind: watchSourceKind as AutomationFormState['watchSourceKind'] })}
            ariaLabel="Choose watch source"
          />
        </Field>
        <Field label="Action">
          <InlinePicker
            value={form.watchActionKind}
            options={[
              { value: 'dispatch', label: 'Dispatch agent' },
              { value: 'notify', label: 'Notify operator' },
              { value: 'steer', label: 'Steer lane' },
              { value: 'approval', label: 'Request approval' },
            ]}
            onChange={(watchActionKind) => update({ watchActionKind: watchActionKind as AutomationFormState['watchActionKind'] })}
            ariaLabel="Choose watch action"
          />
        </Field>
      </div>
      <Field label="Source identity (optional)">
        <input
          type="text"
          aria-label="Watch source identity"
          placeholder="Packet ID, run ID, or repository name"
          value={form.watchSourceId}
          onChange={(event) => update({ watchSourceId: event.target.value })}
          style={inputStyle}
        />
      </Field>
      <Field label="Event types">
        <input
          type="text"
          aria-label="Watch event types"
          placeholder="review_requested, completed, failed"
          value={form.watchEventTypes}
          onChange={(event) => update({ watchEventTypes: event.target.value })}
          style={{ ...inputStyle, fontFamily: MONO_FONT }}
        />
      </Field>
      <Field label="Literal filter (optional)">
        <input
          type="text"
          aria-label="Watch literal filter"
          value={form.watchLiteralFilter}
          onChange={(event) => update({ watchLiteralFilter: event.target.value })}
          style={inputStyle}
        />
      </Field>
      {form.watchSourceKind === 'managed_run' ? (
        <Field label="Quiet interval (ms)">
          <input
            type="number"
            min={1000}
            max={86400000}
            aria-label="Managed run quiet interval in milliseconds"
            value={form.watchQuietMs}
            onChange={(event) => update({ watchQuietMs: Math.max(1_000, Number.parseInt(event.target.value, 10) || 60_000) })}
            style={inputStyle}
          />
        </Field>
      ) : null}
      {form.watchActionKind === 'steer' ? (
        <Field label="Target lane ID">
          <input
            type="text"
            aria-label="Watch steer target lane ID"
            value={form.watchTargetLaneId}
            onChange={(event) => update({ watchTargetLaneId: event.target.value })}
            style={inputStyle}
          />
        </Field>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Minimum interval (ms)">
          <input
            type="number"
            min={0}
            max={86400000}
            aria-label="Watch minimum fire interval in milliseconds"
            value={form.watchMinIntervalMs}
            onChange={(event) => update({ watchMinIntervalMs: Math.max(0, Number.parseInt(event.target.value, 10) || 0) })}
            style={inputStyle}
          />
        </Field>
        <Field label="Batch window (ms)">
          <input
            type="number"
            min={0}
            max={86400000}
            aria-label="Watch batch window in milliseconds"
            value={form.watchBatchWindowMs}
            onChange={(event) => update({ watchBatchWindowMs: Math.max(0, Number.parseInt(event.target.value, 10) || 0) })}
            style={inputStyle}
          />
        </Field>
        <Field label="Fires per tick">
          <input
            type="number"
            min={1}
            max={16}
            aria-label="Watch maximum fires per tick"
            value={form.watchMaxFiresPerTick}
            onChange={(event) => update({ watchMaxFiresPerTick: Math.min(16, Math.max(1, Number.parseInt(event.target.value, 10) || 4)) })}
            style={inputStyle}
          />
        </Field>
      </div>
    </>
  );
}
