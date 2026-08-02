export interface Reservation {
  repositoryId: string;
  requestId: string;
}

export type PersistReservation = (reservation: Reservation) => Promise<void>;

const activeReservations = new Set<string>();

function reservationKey(reservation: Reservation): string {
  return `${reservation.repositoryId}:${reservation.requestId}`;
}

export async function reserve(
  reservation: Reservation,
  persist: PersistReservation,
): Promise<boolean> {
  await persist(reservation);
  activeReservations.add(reservationKey(reservation));
  return true;
}
