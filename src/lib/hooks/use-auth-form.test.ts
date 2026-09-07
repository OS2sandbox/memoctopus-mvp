// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuthForm, AuthMode } from './use-auth-form';

// ─── Initial state ────────────────────────────────────────────────────────────

describe('useAuthForm – initial state', () => {
  it('starts in SignUp mode', () => {
    const { result } = renderHook(() => useAuthForm());
    expect(result.current.state.mode).toBe(AuthMode.SignUp);
  });

  it('starts with empty email', () => {
    const { result } = renderHook(() => useAuthForm());
    expect(result.current.state.email).toBe('');
  });

  it('starts with empty password', () => {
    const { result } = renderHook(() => useAuthForm());
    expect(result.current.state.password).toBe('');
  });

  it('starts with empty name', () => {
    const { result } = renderHook(() => useAuthForm());
    expect(result.current.state.name).toBe('');
  });

  it('starts with isLoading false', () => {
    const { result } = renderHook(() => useAuthForm());
    expect(result.current.state.isLoading).toBe(false);
  });

  it('starts with null error', () => {
    const { result } = renderHook(() => useAuthForm());
    expect(result.current.state.error).toBeNull();
  });

  it('exposes an actions object', () => {
    const { result } = renderHook(() => useAuthForm());
    expect(typeof result.current.actions).toBe('object');
  });
});

// ─── SET_MODE ─────────────────────────────────────────────────────────────────

describe('useAuthForm – setMode', () => {
  it('switches from SignUp to SignIn', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setMode(AuthMode.SignIn);
    });
    expect(result.current.state.mode).toBe(AuthMode.SignIn);
  });

  it('switches from SignIn back to SignUp', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setMode(AuthMode.SignIn);
    });
    act(() => {
      result.current.actions.setMode(AuthMode.SignUp);
    });
    expect(result.current.state.mode).toBe(AuthMode.SignUp);
  });

  it('clears any existing error when mode changes', () => {
    const { result } = renderHook(() => useAuthForm());
    // First set an error
    act(() => {
      result.current.actions.authError('some error');
    });
    expect(result.current.state.error).toBe('some error');

    // Then switch mode — error should clear
    act(() => {
      result.current.actions.setMode(AuthMode.SignIn);
    });
    expect(result.current.state.error).toBeNull();
  });

  it('does not affect email/password/name fields', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setEmail('user@example.com');
      result.current.actions.setPassword('secret');
      result.current.actions.setName('Alice');
    });
    act(() => {
      result.current.actions.setMode(AuthMode.SignIn);
    });
    expect(result.current.state.email).toBe('user@example.com');
    expect(result.current.state.password).toBe('secret');
    expect(result.current.state.name).toBe('Alice');
  });
});

// ─── AUTH_START ───────────────────────────────────────────────────────────────

describe('useAuthForm – authStart', () => {
  it('sets isLoading to true', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.authStart();
    });
    expect(result.current.state.isLoading).toBe(true);
  });

  it('clears a prior error', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.authError('previous error');
    });
    act(() => {
      result.current.actions.authStart();
    });
    expect(result.current.state.error).toBeNull();
  });

  it('does not change the mode', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setMode(AuthMode.SignIn);
    });
    act(() => {
      result.current.actions.authStart();
    });
    expect(result.current.state.mode).toBe(AuthMode.SignIn);
  });

  it('does not clear field values', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setEmail('a@b.com');
    });
    act(() => {
      result.current.actions.authStart();
    });
    expect(result.current.state.email).toBe('a@b.com');
  });
});

// ─── AUTH_ERROR ───────────────────────────────────────────────────────────────

describe('useAuthForm – authError', () => {
  it('stores the error message', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.authError('Invalid credentials');
    });
    expect(result.current.state.error).toBe('Invalid credentials');
  });

  it('resets isLoading to false', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.authStart();
    });
    act(() => {
      result.current.actions.authError('something went wrong');
    });
    expect(result.current.state.isLoading).toBe(false);
  });

  it('overwrites a previous error with the new one', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.authError('first error');
    });
    act(() => {
      result.current.actions.authError('second error');
    });
    expect(result.current.state.error).toBe('second error');
  });

  it('stores an empty string error when passed empty string', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.authError('');
    });
    expect(result.current.state.error).toBe('');
  });

  it('does not change the mode', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.authError('error');
    });
    expect(result.current.state.mode).toBe(AuthMode.SignUp);
  });
});

// ─── Field setters ────────────────────────────────────────────────────────────

describe('useAuthForm – setEmail', () => {
  it('updates the email field', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setEmail('test@example.com');
    });
    expect(result.current.state.email).toBe('test@example.com');
  });

  it('does not affect other fields', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setPassword('pass');
      result.current.actions.setName('Bob');
    });
    act(() => {
      result.current.actions.setEmail('new@example.com');
    });
    expect(result.current.state.password).toBe('pass');
    expect(result.current.state.name).toBe('Bob');
  });

  it('can be updated multiple times', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setEmail('first@example.com');
    });
    act(() => {
      result.current.actions.setEmail('second@example.com');
    });
    expect(result.current.state.email).toBe('second@example.com');
  });

  it('accepts an empty string (clear)', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setEmail('something@example.com');
    });
    act(() => {
      result.current.actions.setEmail('');
    });
    expect(result.current.state.email).toBe('');
  });
});

describe('useAuthForm – setPassword', () => {
  it('updates the password field', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setPassword('hunter2');
    });
    expect(result.current.state.password).toBe('hunter2');
  });

  it('does not affect other fields', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setEmail('e@e.com');
      result.current.actions.setName('Carol');
    });
    act(() => {
      result.current.actions.setPassword('newpass');
    });
    expect(result.current.state.email).toBe('e@e.com');
    expect(result.current.state.name).toBe('Carol');
  });

  it('can be updated multiple times', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setPassword('first');
    });
    act(() => {
      result.current.actions.setPassword('second');
    });
    expect(result.current.state.password).toBe('second');
  });
});

describe('useAuthForm – setName', () => {
  it('updates the name field', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setName('Alice Wonderland');
    });
    expect(result.current.state.name).toBe('Alice Wonderland');
  });

  it('does not affect other fields', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setEmail('e@e.com');
      result.current.actions.setPassword('pass');
    });
    act(() => {
      result.current.actions.setName('Dave');
    });
    expect(result.current.state.email).toBe('e@e.com');
    expect(result.current.state.password).toBe('pass');
  });

  it('accepts unicode names', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setName('Søren Ørsted');
    });
    expect(result.current.state.name).toBe('Søren Ørsted');
  });
});

// ─── setLoading ───────────────────────────────────────────────────────────────

describe('useAuthForm – setLoading', () => {
  it('sets isLoading to true', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setLoading(true);
    });
    expect(result.current.state.isLoading).toBe(true);
  });

  it('sets isLoading back to false', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.setLoading(true);
    });
    act(() => {
      result.current.actions.setLoading(false);
    });
    expect(result.current.state.isLoading).toBe(false);
  });

  it('does not affect error', () => {
    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.actions.authError('some error');
    });
    act(() => {
      result.current.actions.setLoading(true);
    });
    expect(result.current.state.error).toBe('some error');
  });
});

// ─── actions stability ────────────────────────────────────────────────────────

describe('useAuthForm – actions object stability', () => {
  it('returns the same actions reference across re-renders (useMemo)', () => {
    const { result, rerender } = renderHook(() => useAuthForm());
    const firstActions = result.current.actions;
    rerender();
    expect(result.current.actions).toBe(firstActions);
  });
});

// ─── Combined scenarios ───────────────────────────────────────────────────────

describe('useAuthForm – combined scenarios', () => {
  it('full sign-in flow: fill fields → start → error', () => {
    const { result } = renderHook(() => useAuthForm());

    act(() => {
      result.current.actions.setMode(AuthMode.SignIn);
      result.current.actions.setEmail('user@example.com');
      result.current.actions.setPassword('badpass');
    });

    expect(result.current.state.mode).toBe(AuthMode.SignIn);
    expect(result.current.state.email).toBe('user@example.com');
    expect(result.current.state.password).toBe('badpass');
    expect(result.current.state.isLoading).toBe(false);

    act(() => {
      result.current.actions.authStart();
    });

    expect(result.current.state.isLoading).toBe(true);
    expect(result.current.state.error).toBeNull();

    act(() => {
      result.current.actions.authError('Wrong password');
    });

    expect(result.current.state.isLoading).toBe(false);
    expect(result.current.state.error).toBe('Wrong password');
    // Fields preserved after error
    expect(result.current.state.email).toBe('user@example.com');
    expect(result.current.state.password).toBe('badpass');
  });

  it('switching mode mid-error clears error but preserves fields', () => {
    const { result } = renderHook(() => useAuthForm());

    act(() => {
      result.current.actions.setEmail('x@x.com');
      result.current.actions.authError('Oops');
    });

    act(() => {
      result.current.actions.setMode(AuthMode.SignIn);
    });

    expect(result.current.state.error).toBeNull();
    expect(result.current.state.email).toBe('x@x.com');
  });
});
