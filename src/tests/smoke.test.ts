import { describe, expect, it } from 'vitest';
import { AppError } from '../core/errors.js';

describe('test harness', () => {
  it('loads TypeScript modules through Vitest', () => {
    const error = new AppError('validation_failed', 'Invalid fixture');
    expect(error.code).toBe('validation_failed');
    expect(error.message).toBe('Invalid fixture');
  });
});
