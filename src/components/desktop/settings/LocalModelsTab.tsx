'use client';

import { APP_FONT_STACK, SETTINGS_CONTENT_MAX_WIDTH, TabHeading } from './shared';
import { LocalModelsSection } from './LocalModelsSection';
import { useModelSettings } from './useModelSettings';
import { ENV_LOCKED_REASON } from './dispatch-shared';

export function LocalModelsTab() {
  const { data, loading, notice, busyField, updateField } = useModelSettings();
  return (
    <div style={{ paddingTop: 8, paddingLeft: 8, paddingRight: 8, paddingBottom: 40, maxWidth: SETTINGS_CONTENT_MAX_WIDTH, fontFamily: APP_FONT_STACK }}>
      <TabHeading title="local models" subtitle="Connect models running on your computer or a server you control. Configure the endpoint and the models o8 uses here." />
      {notice ? <p role="status" style={{ color: 'var(--t-text)', fontSize: 13 }}>{notice}</p> : null}
      {loading && !data ? <p>Loading local model settings…</p> : null}
      {data ? <LocalModelsSection values={data.values} sources={data.sources} busyField={busyField}
        envDisabledReason={ENV_LOCKED_REASON} onCommit={(field, value) => updateField(field, value)} /> : null}
    </div>
  );
}
