export function ClearToast() {
  return (
    <div
      style={{
        paddingTop: 6,
        paddingRight: 10,
        paddingBottom: 6,
        paddingLeft: 10,
        borderRadius: 10,
        border: '1px solid var(--t-divider-subtle)',
        background: 'var(--t-panel-translucent)',
        color: 'var(--t-text-muted)',
        fontSize: 11,
        fontFamily: '"SF Mono", ui-monospace, monospace',
      }}
    >
      Thread archived · Orchestrator ready.
    </div>
  );
}
