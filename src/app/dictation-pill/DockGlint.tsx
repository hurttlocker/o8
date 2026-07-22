import type { PlanProgressGlint } from '@/components/desktop/dictation/planPresentation';

interface DockGlintProps {
  glint: PlanProgressGlint;
  fading: boolean;
}

/** Quiet, pointer-transparent lifecycle chip below the dock. */
export function DockGlint({ glint, fading }: DockGlintProps) {
  return (
    <div
      style={{
        marginTop: 6,
        paddingTop: 3,
        paddingBottom: 3,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 9,
        background: 'linear-gradient(#14182299, #0e121c8a)',
        border: glint.tone === 'error'
          ? '1px solid #ff78785c'
          : glint.tone === 'warning'
            ? '1px solid #f4c97752'
            : glint.tone === 'success'
              ? '1px solid #69e0ad47'
              : '1px solid #ffffff24',
        fontSize: 9.5,
        fontWeight: 260,
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
        color: glint.tone === 'error'
          ? '#ffc4c4eb'
          : glint.tone === 'warning'
            ? '#fadea8e6'
            : glint.tone === 'success'
              ? '#b7f4d8e6'
              : '#ffffffd1',
        textShadow: '0 1px 4px #00000059',
        whiteSpace: 'nowrap',
        opacity: fading ? 0 : 1,
        transition: 'opacity 0.5s ease',
        animation: 'o8GlintIn 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
        pointerEvents: 'none',
      }}
    >
      {glint.text}
      <style>{'@keyframes o8GlintIn { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }'}</style>
    </div>
  );
}
