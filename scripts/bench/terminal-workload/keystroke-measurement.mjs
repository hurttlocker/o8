export function classifyKeystrokeTimeout({ auxDeliveredAt, panelDeliveredAt, panelPaintedAt }) {
  if (Number.isFinite(panelPaintedAt)) return 'painted-but-missed';
  if (Number.isFinite(panelDeliveredAt) || Number.isFinite(auxDeliveredAt)) return 'delivered-not-painted';
  return 'not-delivered';
}
