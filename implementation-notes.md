## Implementation Notes

- Mount entrance is applied from `page.tsx` with temporary inline animation styles on committed `[data-card-id]` roots, then cleared after the border draw-on finishes.
- Multi-agent spawn intent queues a shared viewport-center origin and 60ms stagger entries; the lane watcher consumes them as live agent cards bloom and sweeps each card into a reserved `findFreeSpot` target.
- Reduced motion uses a short opacity-only fade and skips stagger/sweep choreography.

## Deviations

- Used inline animation styles instead of a mount-only CSS class because repo directives permanently ban CSS classes on this surface.
