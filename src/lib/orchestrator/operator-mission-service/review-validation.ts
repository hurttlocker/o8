/** Expected caller rejection, distinct from a failed review service operation. */
export class ReviewValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ReviewValidationError';
  }
}
