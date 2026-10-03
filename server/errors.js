export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.status = status
  }
}

export function invariant(condition, code, message, status = 400) {
  if (!condition) throw new DomainError(code, message, status)
}
