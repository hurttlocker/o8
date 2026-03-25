# Cortex Brand System

This document defines the current desktop product theme direction. All agents making UI changes should read this before editing visual surfaces.

## Theme Name
Cortex Glass Light

## Product Mood
- Calm, premium, operator-grade
- Apple-adjacent clarity, not generic SaaS gloss
- Technical, but never noisy
- High trust through spacing, contrast, and hierarchy

## Core Principles
- One system, not stacked widgets. Adjacent surfaces should feel like parts of the same shell.
- Primary actions must be obvious in under one second.
- Status should read instantly from color and shape, not dense text.
- Dense information is allowed only when the layout still feels breathable.
- Progressive disclosure beats permanent clutter.

## Visual Language
- Use soft glass surfaces with warm white or cool blue tints.
- Prefer large radii: 16px, 18px, 20px, 22px.
- Use thin borders with low-opacity blue or slate tones.
- Shadows should be soft and wide, never harsh or muddy.
- Avoid flat gray boxes unless the surface is intentionally inactive.

## Color Direction
- Primary blue: `#2563eb`
- Deeper blue accent: `#1d4ed8`
- Success green: `#16a34a` and `#34c759`
- Caution orange: `#f97316` and `#f59e0b`
- Danger red: `#ef4444`
- Main text should stay slate or near-black, not pure blue
- Blue is for focus, selection, and primary action
- Orange is for activity, momentum, and attention
- Green is for healthy/live state
- Red is only for destructive or broken state

## Typography
- Bold, compact titles with tight tracking
- Subtitles should be softer and quieter, not tiny
- Uppercase overlines are allowed sparingly for category framing
- Avoid excessive all-caps section labels
- Metadata should be de-emphasized, never louder than the main label

## Spacing
- Section-to-section spacing should feel generous: 12px to 16px
- Internal card padding should usually land between 12px and 18px
- Expanded states need more space than collapsed states
- When in doubt, add breathing room before adding another divider

## Component Rules
- Hero surfaces should feel anchored and premium
- Section headers should use the same card grammar across panels
- Pills should be rounded, compact, and semantically colored
- Bottom utility trays should open upward and clearly own their scroll region
- Dropdowns and pickers should feel like floating glass sheets, not default menus
- Diff, status, and metrics chips should look related, not bespoke

## Motion
- Use calm motion only
- Favor 180ms to 260ms easing
- Expansion should feel cushioned, not springy or playful
- Hover states should brighten or lift subtly, never flash

## Chat And Agent Surfaces
- Session headers should read like premium selector cards
- Diff stats should feel like one refined capsule, not multiple loose counters
- Tool/result cards should use the same design family as sidebar cards
- Activity/timeline surfaces should feel docked and intentional

## Avoid
- Tiny cramped controls
- Multiple unrelated card styles in one panel
- Hard black borders
- Neon gradients
- Purple-by-default styling
- Dense badge spam
- Footer/status-bar clutter unless the information is truly actionable

## Implementation Notes
- Reuse existing blue/white glass tokens where possible instead of inventing new palettes
- If a new surface is added, first decide whether it belongs as a hero, section card, tray, or row item
- New desktop UI should visually align with the left sidebar and agent chat header before branching out
