/**
 * Domain errors thrown by the data layer. They stay framework-agnostic; an
 * HTTP layer maps `code` to a status (NOT_FOUND → 404, CONFLICT-like codes →
 * 409, VALIDATION → 422).
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: unknown) {
    super('NOT_FOUND', `${entity} ${String(id)} not found`, { entity, id: String(id) });
  }
}

export class DomainValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, details);
  }
}

export class InsufficientInventoryError extends DomainError {
  constructor(details: { roomTypeId: string; requested: number; failingNights: string[] }) {
    super('ROOM_NOT_AVAILABLE', 'The selected room is not available.', details);
  }
}

export class InventoryNotInitializedError extends DomainError {
  constructor(details: { roomTypeId: string; missingNights: string[] }) {
    super('INVENTORY_NOT_INITIALIZED', 'Requested dates are outside the sellable inventory horizon', details);
  }
}

export class RestrictionViolationError extends DomainError {
  constructor(violations: string[]) {
    super('RESTRICTION_VIOLATION', violations.join('; '), { violations });
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(entity: string, from: string, to: string) {
    super('INVALID_STATE_TRANSITION', `${entity} cannot go from ${from} to ${to}`, { from, to });
  }
}

export class RoomAssignmentConflictError extends DomainError {
  constructor(details: Record<string, unknown>) {
    super('ROOM_ASSIGNMENT_CONFLICT', 'Room is already assigned or blocked for overlapping dates', details);
  }
}

export class DuplicateError extends DomainError {
  constructor(entity: string, key: Record<string, unknown> | undefined) {
    super('DUPLICATE', `${entity} already exists`, { key });
  }
}

/** An inventory row violated the counting invariant. This is a bug or manual tampering, so page someone. */
export class InventoryInvariantError extends DomainError {
  constructor(details: Record<string, unknown>) {
    super('INVENTORY_INVARIANT', 'Inventory counters are inconsistent with reservations', details);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have access to this resource', code = 'FORBIDDEN') {
    super(code, message);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
    super(code, message);
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

/** A channel adapter cannot perform the call (partner access missing, capability absent, provider error). */
export class ChannelError extends DomainError {
  constructor(code: string, message: string, readonly retryable = false, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}
