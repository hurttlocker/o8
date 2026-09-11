export function classifyKeystrokeTimeout({ auxDeliveredAt, panelDeliveredAt, panelPaintedAt }) {
  if (Number.isFinite(panelPaintedAt)) return 'painted-but-missed';
  if (Number.isFinite(panelDeliveredAt)) return 'delivered-not-painted';
  if (Number.isFinite(auxDeliveredAt)) return 'aux-delivered-panel-unobserved';
  return 'not-delivered';
}
