export interface PositionedCanvasCard {
  id: number;
  x: number;
  y: number;
}

export function spawnCanvasCard<Card>(cards: Card[], card: Card): Card[] {
  return [...cards, card];
}

export function moveCanvasCard<Card extends PositionedCanvasCard>(
  cards: Card[],
  id: number,
  x: number,
  y: number,
): Card[] {
  return cards.map((card) => (card.id === id ? { ...card, x, y } : card));
}
