'use client';

import { Fragment, useState } from 'react';

import type {
  AgentRoleRoute,
  RoleRouteSource,
} from '@/lib/operator/role-routing';
import type { RoleRoutingReceipt } from '@/lib/operator/role-routing-ledger';
import { APP_FONT_STACK, RAMS_INK_QUIET } from './shared';
import { RowDivider, SettingsGroup, SettingsRow, ValuePill } from './grouped';

function RouteIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="12" r="2" />
      <circle cx="6" cy="18" r="2" />
      <path d="M8 6h2a4 4 0 0 1 4 4v0a2 2 0 0 0 2 2" />
      <path d="M8 18h2a4 4 0 0 0 4-4v0a2 2 0 0 1 2-2" />
    </svg>
  );
}

function DisclosureIcon({ open }: { open: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0, color: RAMS_INK_QUIET }}>
      <polyline points={open ? '6 15 12 9 18 15' : '9 18 15 12 9 6'} />
    </svg>
  );
}

const SOURCE_LABELS: Record<RoleRouteSource, string> = {
  env: 'Environment',
  file: 'Operator setting',
  profile: 'Subscription profile',
  default: 'First-run default',
  'runtime-default': 'Runtime default',
  derived: 'Derived',
  'request-time': 'Request-time decision',
};

function sourceSummary(route: AgentRoleRoute): string {
  return [
    `Backend: ${SOURCE_LABELS[route.sources.backend]}`,
    `Runtime: ${SOURCE_LABELS[route.sources.runtime]}`,
    `Model: ${SOURCE_LABELS[route.sources.model]}`,
    `Effort: ${SOURCE_LABELS[route.sources.effort]}`,
  ].join(' · ');
}

function statusLabel(route: AgentRoleRoute): string {
  if (route.availability.status === 'ready') return 'Ready';
  if (route.availability.status === 'unavailable') return 'Needs attention';
  return 'Checked at launch';
}

function DetailLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '104px minmax(0, 1fr)', columnGap: 12, alignItems: 'start' }}>
      <span style={{ fontFamily: APP_FONT_STACK, fontSize: 10.5, fontWeight: 400, letterSpacing: '0.06em', textTransform: 'uppercase', color: RAMS_INK_QUIET }}>
        {label}
      </span>
      <span style={{ fontFamily: APP_FONT_STACK, fontSize: 11.5, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)', minWidth: 0 }}>
        {children}
      </span>
    </div>
  );
}

function RouteDetails({ route, receipt }: { route: AgentRoleRoute; receipt?: RoleRoutingReceipt }) {
  return (
    <div style={{ paddingLeft: 54, paddingRight: 18, paddingTop: 2, paddingBottom: 14, display: 'flex', flexDirection: 'column', gap: 7 }}>
      <DetailLine label="Configured">{route.configured.label}</DetailLine>
      <DetailLine label="Effective">{route.effective.label}</DetailLine>
      <DetailLine label="Source">{sourceSummary(route)}</DetailLine>
      <DetailLine label="Availability">
        {route.availability.detail}
        {route.availability.fix ? ` ${route.availability.fix}` : ''}
      </DetailLine>
      <DetailLine label="Why">{route.reason}</DetailLine>
      <DetailLine label="Change in">{route.changePath}</DetailLine>
      <DetailLine label="Last ran">
        {receipt?.effective
          ? `${receipt.effective.label} · ${new Date(receipt.createdAt).toLocaleString()}`
          : 'No recorded execution yet.'}
      </DetailLine>
      {receipt?.fallbackReason ? (
        <DetailLine label="Last fallback">{receipt.fallbackReason}</DetailLine>
      ) : null}
      {route.fallbacks.length > 0 ? (
        <DetailLine label="Fallbacks">{route.fallbacks.join(' → ')}</DetailLine>
      ) : null}
    </div>
  );
}

export function AgentRoleRoutingSection({
  routes,
  receipts,
}: {
  routes: AgentRoleRoute[];
  receipts: RoleRoutingReceipt[];
}) {
  const [openRole, setOpenRole] = useState<AgentRoleRoute['id'] | null>(null);

  if (routes.length === 0) return null;

  return (
    <section>
      <SettingsGroup
        header="Runtime routing"
        footnote="Configured is what you chose. Effective is what o8 will launch after defaults and follow-rules resolve. Expand a role to see readiness, ownership, and fallbacks."
      >
        {routes.map((route, index) => {
          const open = route.id === openRole;
          const last = index === routes.length - 1;
          const receipt = receipts.find((candidate) => candidate.role === route.id);
          return (
            <Fragment key={route.id}>
              <SettingsRow
                icon={<RouteIcon />}
                label={route.label}
                subtitle={`Configured: ${route.configured.label}`}
                accessory={(
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span style={{ fontFamily: APP_FONT_STACK, fontSize: 12, fontWeight: 300, color: 'var(--t-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 210 }}>
                      {route.effective.label}
                    </span>
                    <ValuePill tone={route.availability.status === 'unavailable' ? 'destructive' : route.availability.status === 'ready' ? 'success' : 'default'}>
                      {statusLabel(route)}
                    </ValuePill>
                    <DisclosureIcon open={open} />
                  </div>
                )}
                onPress={() => { setOpenRole((current) => current === route.id ? null : route.id); }}
                ariaExpanded={open}
                divider={!open && !last}
              />
              {open ? <RouteDetails route={route} receipt={receipt} /> : null}
              {open && !last ? <RowDivider /> : null}
            </Fragment>
          );
        })}
      </SettingsGroup>
    </section>
  );
}
