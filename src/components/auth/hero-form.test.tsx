// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { HeroForm } from './hero-form';

const mockPush = vi.fn();
const mockSearchParamsGet = vi.fn().mockReturnValue(null);
const mockRouter = { push: mockPush };
const mockSearchParamsObj = { get: mockSearchParamsGet };

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParamsObj,
}));

const mockSignInEmail = vi.fn();
const mockSignInSocial = vi.fn();
const mockSignUpEmail = vi.fn();

vi.mock('@/lib/auth-client', () => ({
  signIn: {
    email: (...args: unknown[]) => mockSignInEmail(...args),
    social: (...args: unknown[]) => mockSignInSocial(...args),
  },
  signUp: {
    email: (...args: unknown[]) => mockSignUpEmail(...args),
  },
}));

function renderForm() {
  return render(<HeroForm />);
}

beforeEach(() => {
  mockPush.mockReset();
  mockSearchParamsGet.mockReturnValue(null);
  mockSignInEmail.mockReset();
  mockSignInSocial.mockReset();
  mockSignUpEmail.mockReset();
  delete process.env.NEXT_PUBLIC_MICROSOFT_ENABLED;
});

describe('HeroForm — initial render (sign-up mode)', () => {
  it('renders the sign-up heading', () => {
    renderForm();
    expect(screen.getByText('Opret din konto')).toBeInTheDocument();
  });

  it('renders the sign-up subtitle', () => {
    renderForm();
    expect(screen.getByText('Gratis at komme i gang — intet kort påkrævet.')).toBeInTheDocument();
  });

  it('renders name, email, and password fields in sign-up mode', () => {
    renderForm();
    expect(screen.getByLabelText('Navn')).toBeInTheDocument();
    expect(screen.getByLabelText('E-mail')).toBeInTheDocument();
    expect(screen.getByLabelText('Adgangskode')).toBeInTheDocument();
  });

  it('renders the submit button labelled "Opret konto"', () => {
    renderForm();
    expect(screen.getByRole('button', { name: 'Opret konto' })).toBeInTheDocument();
  });

  it('renders the "Har du allerede en konto?" toggle link', () => {
    renderForm();
    expect(screen.getByText('Har du allerede en konto?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log ind' })).toBeInTheDocument();
  });

  it('does not show an error banner initially', () => {
    renderForm();
    expect(screen.queryByText(/mislykkedes|Kunne ikke/)).toBeNull();
  });
});

describe('HeroForm — mode toggle', () => {
  it('switches to sign-in mode when the toggle link is clicked', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Log ind' }));
    await waitFor(() => {
      expect(screen.getByText('Velkommen tilbage')).toBeInTheDocument();
    });
  });

  it('hides the name field after switching to sign-in mode', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Log ind' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('Navn')).toBeNull();
    });
  });

  it('shows sign-in subtitle after switching to sign-in mode', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Log ind' }));
    await waitFor(() => {
      expect(screen.getByText('Log ind for at fortsætte.')).toBeInTheDocument();
    });
  });

  it('renders "Log ind" submit button in sign-in mode', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Log ind' }));
    await waitFor(() => {
      const submitBtn = screen.getByRole('button', { name: 'Log ind', hidden: false });
      expect(submitBtn).toHaveAttribute('type', 'submit');
    });
  });

  it('switches back to sign-up mode when the toggle is clicked again', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Log ind' }));
    await waitFor(() => screen.getByText('Velkommen tilbage'));
    fireEvent.click(screen.getByRole('button', { name: 'Opret konto' }));
    await waitFor(() => {
      expect(screen.getByText('Opret din konto')).toBeInTheDocument();
    });
  });

  it('clears the error when switching modes', async () => {
    mockSignInEmail.mockResolvedValueOnce({ error: { message: 'bad' } });
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Log ind' }));
    await waitFor(() => screen.getByText('Velkommen tilbage'));

    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'pw' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Log ind', hidden: false }).closest('form')!);
    });
    await waitFor(() => screen.getByText('Kunne ikke logge ind. Tjek venligst dine oplysninger.'));

    fireEvent.click(screen.getByRole('button', { name: 'Opret konto' }));
    await waitFor(() => {
      expect(screen.queryByText('Kunne ikke logge ind. Tjek venligst dine oplysninger.')).toBeNull();
    });
  });
});

describe('HeroForm — password visibility toggle', () => {
  it('password field is type="password" by default', () => {
    renderForm();
    expect(screen.getByLabelText('Adgangskode')).toHaveAttribute('type', 'password');
  });

  it('toggles password visibility when the eye button is clicked', async () => {
    renderForm();
    const toggle = screen.getByRole('button', { name: 'Vis adgangskode' });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByLabelText('Adgangskode')).toHaveAttribute('type', 'text');
    });
  });

  it('toggles password back to hidden on second click', async () => {
    renderForm();
    const toggle = screen.getByRole('button', { name: 'Vis adgangskode' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByLabelText('Adgangskode')).toHaveAttribute('type', 'password');
    });
  });
});

describe('HeroForm — sign-up submit', () => {
  it('calls signUp.email then signIn.email on successful sign-up', async () => {
    mockSignUpEmail.mockResolvedValueOnce({ error: null });
    mockSignInEmail.mockResolvedValueOnce({ error: null });

    renderForm();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'jane@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'secret123' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Opret konto' }).closest('form')!);
    });

    expect(mockSignUpEmail).toHaveBeenCalledWith({ name: 'Jane Doe', email: 'jane@example.com', password: 'secret123' });
    expect(mockSignInEmail).toHaveBeenCalledWith({ email: 'jane@example.com', password: 'secret123', rememberMe: true });
  });

  it('redirects to /dashboard after successful sign-up', async () => {
    mockSignUpEmail.mockResolvedValueOnce({ error: null });
    mockSignInEmail.mockResolvedValueOnce({ error: null });

    renderForm();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'jane@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'pw' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Opret konto' }).closest('form')!);
    });

    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('redirects to the "from" param after successful sign-up', async () => {
    mockSearchParamsGet.mockReturnValue('/meeting/abc');
    mockSignUpEmail.mockResolvedValueOnce({ error: null });
    mockSignInEmail.mockResolvedValueOnce({ error: null });

    renderForm();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'jane@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'pw' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Opret konto' }).closest('form')!);
    });

    expect(mockPush).toHaveBeenCalledWith('/meeting/abc');
  });

  it('shows error when signUp.email fails', async () => {
    mockSignUpEmail.mockResolvedValueOnce({ error: { message: 'email taken' } });

    renderForm();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'jane@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'pw' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Opret konto' }).closest('form')!);
    });

    await waitFor(() => {
      expect(screen.getByText('Kunne ikke oprette konto. E-mailen er muligvis allerede i brug.')).toBeInTheDocument();
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows a password-length message for the PASSWORD_TOO_SHORT code', async () => {
    mockSignUpEmail.mockResolvedValueOnce({ error: { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' } });

    renderForm();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'jane@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'short' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Opret konto' }).closest('form')!);
    });

    await waitFor(() => {
      expect(screen.getByText('Adgangskoden skal være mindst 8 tegn.')).toBeInTheDocument();
    });
  });

  it('shows an "email already in use" message for the USER_ALREADY_EXISTS code', async () => {
    mockSignUpEmail.mockResolvedValueOnce({ error: { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', message: 'exists' } });

    renderForm();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'jane@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'hunter2hunter2' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Opret konto' }).closest('form')!);
    });

    await waitFor(() => {
      expect(screen.getByText('E-mailen er allerede i brug. Log ind i stedet.')).toBeInTheDocument();
    });
  });

  it('shows error when sign-up succeeds but subsequent sign-in fails', async () => {
    mockSignUpEmail.mockResolvedValueOnce({ error: null });
    mockSignInEmail.mockResolvedValueOnce({ error: { message: 'auth failed' } });

    renderForm();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'jane@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'pw' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Opret konto' }).closest('form')!);
    });

    await waitFor(() => {
      expect(screen.getByText('Konto oprettet, men login mislykkedes. Prøv at logge ind.')).toBeInTheDocument();
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows loading text while submitting', async () => {
    let resolveSignUp!: (v: unknown) => void;
    mockSignUpEmail.mockReturnValueOnce(new Promise((r) => { resolveSignUp = r; }));
    mockSignInEmail.mockResolvedValueOnce({ error: null });

    renderForm();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'jane@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'pw' } });

    fireEvent.submit(screen.getByRole('button', { name: 'Opret konto' }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Behandler…' })).toBeDisabled();
    });

    await act(async () => { resolveSignUp({ error: null }); });
  });
});

describe('HeroForm — sign-in submit', () => {
  function switchToSignIn() {
    fireEvent.click(screen.getByRole('button', { name: 'Log ind' }));
  }

  it('calls signIn.email with email, password, and rememberMe on submit', async () => {
    mockSignInEmail.mockResolvedValueOnce({ error: null });

    renderForm();
    switchToSignIn();
    await waitFor(() => screen.getByText('Velkommen tilbage'));

    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'mypassword' } });

    await act(async () => {
      fireEvent.submit(screen.getByLabelText('E-mail').closest('form')!);
    });

    expect(mockSignInEmail).toHaveBeenCalledWith({ email: 'user@example.com', password: 'mypassword', rememberMe: true });
    expect(mockSignUpEmail).not.toHaveBeenCalled();
  });

  it('redirects to /dashboard on successful sign-in', async () => {
    mockSignInEmail.mockResolvedValueOnce({ error: null });

    renderForm();
    switchToSignIn();
    await waitFor(() => screen.getByText('Velkommen tilbage'));

    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'pw' } });

    await act(async () => {
      fireEvent.submit(screen.getByLabelText('E-mail').closest('form')!);
    });

    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('shows error when signIn.email fails', async () => {
    mockSignInEmail.mockResolvedValueOnce({ error: { message: 'invalid credentials' } });

    renderForm();
    switchToSignIn();
    await waitFor(() => screen.getByText('Velkommen tilbage'));

    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'wrong' } });

    await act(async () => {
      fireEvent.submit(screen.getByLabelText('E-mail').closest('form')!);
    });

    await waitFor(() => {
      expect(screen.getByText('Kunne ikke logge ind. Tjek venligst dine oplysninger.')).toBeInTheDocument();
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does not call signUp.email in sign-in mode', async () => {
    mockSignInEmail.mockResolvedValueOnce({ error: null });

    renderForm();
    switchToSignIn();
    await waitFor(() => screen.getByText('Velkommen tilbage'));

    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'pw' } });

    await act(async () => {
      fireEvent.submit(screen.getByLabelText('E-mail').closest('form')!);
    });

    expect(mockSignUpEmail).not.toHaveBeenCalled();
  });

  it('shows loading state while sign-in is in progress', async () => {
    let resolveSignIn!: (v: unknown) => void;
    mockSignInEmail.mockReturnValueOnce(new Promise((r) => { resolveSignIn = r; }));

    renderForm();
    switchToSignIn();
    await waitFor(() => screen.getByText('Velkommen tilbage'));

    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Adgangskode'), { target: { value: 'pw' } });

    fireEvent.submit(screen.getByLabelText('E-mail').closest('form')!);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Behandler…' })).toBeDisabled();
    });

    await act(async () => { resolveSignIn({ error: null }); });
  });
});

describe('HeroForm — Microsoft sign-in', () => {
  it('does not render Microsoft button when NEXT_PUBLIC_MICROSOFT_ENABLED is not "true"', () => {
    renderForm();
    expect(screen.queryByText('Fortsæt med Microsoft')).toBeNull();
  });

  it('renders Microsoft button when NEXT_PUBLIC_MICROSOFT_ENABLED is "true"', () => {
    process.env.NEXT_PUBLIC_MICROSOFT_ENABLED = 'true';
    renderForm();
    expect(screen.getByText('Fortsæt med Microsoft')).toBeInTheDocument();
  });

  it('calls signIn.social with provider=microsoft on Microsoft button click', async () => {
    process.env.NEXT_PUBLIC_MICROSOFT_ENABLED = 'true';
    mockSignInSocial.mockResolvedValueOnce({ error: null });

    renderForm();
    await act(async () => {
      fireEvent.click(screen.getByText('Fortsæt med Microsoft'));
    });

    expect(mockSignInSocial).toHaveBeenCalledWith({ provider: 'microsoft', callbackURL: '/dashboard' });
  });

  it('shows error when Microsoft sign-in returns an error message', async () => {
    process.env.NEXT_PUBLIC_MICROSOFT_ENABLED = 'true';
    mockSignInSocial.mockResolvedValueOnce({ error: { message: 'oauth failed' } });

    renderForm();
    await act(async () => {
      fireEvent.click(screen.getByText('Fortsæt med Microsoft'));
    });

    await waitFor(() => {
      expect(screen.getByText('Microsoft login mislykkedes. Prøv igen.')).toBeInTheDocument();
    });
  });

  it('passes the "from" search param as callbackURL to Microsoft sign-in', async () => {
    process.env.NEXT_PUBLIC_MICROSOFT_ENABLED = 'true';
    mockSearchParamsGet.mockReturnValue('/meeting/xyz');
    mockSignInSocial.mockResolvedValueOnce({ error: null });

    renderForm();
    await act(async () => {
      fireEvent.click(screen.getByText('Fortsæt med Microsoft'));
    });

    expect(mockSignInSocial).toHaveBeenCalledWith({ provider: 'microsoft', callbackURL: '/meeting/xyz' });
  });
});
