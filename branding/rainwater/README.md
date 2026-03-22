# Rainwater Branding Assets

Exploring "Rainwater IDE" as a potential rebrand of Cortex IDE.

## Animated Logo Component

`src/components/shared/RainwaterLogo.tsx` — Pure SVG + framer-motion.

4 falling droplets (staggered entry), 2 ripple rings, shimmer highlight on the impact droplet.

### Usage

```tsx
import { RainwaterLogo } from "@/components/shared/RainwaterLogo";

// Default (48px, inherits currentColor)
<RainwaterLogo />

// Custom size + color
<RainwaterLogo size={28} color="#181515" />

// For the NavRail logo slot
<RainwaterLogo size={28} color="var(--t-text)" />
```

### Where the brain icon currently lives

| Location | File | Current |
|---|---|---|
| NavRail logo | `src/components/desktop/NavRail.tsx` → `CortexLogo()` | `<img src="/icons/icon-192x192.png">` |
| Settings brain | `src/components/desktop/SettingsPage.tsx` → `BrainIcon()` | Inline SVG (lucide brain) |
| Chat brain | `src/components/desktop/DesktopChat.tsx` | `<Brain>` from lucide-react |
| LLM Chat | `src/components/desktop/LLMChat.tsx` | `<Brain>` from lucide-react |
| Setup Wizard | `src/components/desktop/SetupWizard.tsx` | `<Brain>` from lucide-react |
| Mobile status | `src/components/mobile/CortexStatus.tsx` | `<Brain>` from lucide-react |

### Quick swap (NavRail only)

Replace the `<img>` in `CortexLogo()`:

```tsx
import { RainwaterLogo } from "@/components/shared/RainwaterLogo";

function CortexLogo({ expanded }: { expanded: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <RainwaterLogo size={28} color="var(--t-text)" />
      <motion.span animate={{ opacity: expanded ? 1 : 0 }}>
        RAINWATER
      </motion.span>
    </div>
  );
}
```

## Static Concepts

- `rainwater-logo-concept-1.png`
- `rainwater-logo-concept-2.png`
- `rainwater-logo-concept-3.png`

Ported from `hurttlocker/sleeping-beauties` (PLP repo).
