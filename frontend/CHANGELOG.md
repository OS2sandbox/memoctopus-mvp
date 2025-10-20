# Changelog

All notable changes to the MemOctopus frontend will be documented in this file.

## [Unreleased]

### Removed - October 10, 2025
- **Discord OAuth Integration** - Removed Discord as an authentication provider
  - Removed Discord configuration from `lib/auth.ts`
  - Removed Discord button from sign-in page (`app/auth/sign-in/page.tsx`)
  - Removed Discord environment variables from `.env.local` and `.env.example`
  - Application now supports Microsoft OAuth only

### Current Authentication Methods
- ✅ Microsoft OAuth (Azure AD)
- ✅ Email/Password (enabled but no UI yet)

### Files Modified
- `lib/auth.ts` - Removed Discord social provider configuration
- `app/auth/sign-in/page.tsx` - Removed Discord sign-in button and handler
- `.env.local` - Removed DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET
- `.env.example` - Removed Discord OAuth section

### Migration Notes
If you have existing Discord OAuth credentials configured:
1. Remove or comment out `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` from `.env.local`
2. Users who previously signed in with Discord will no longer be able to authenticate
3. Consider migrating users to Microsoft authentication

---

## [Initial Release] - October 10, 2025

### Added
- Next.js 15 application with TypeScript
- Better Auth integration with PostgreSQL
- Microsoft OAuth authentication
- Discord OAuth authentication (later removed)
- Custom auth components (SignedIn, SignedOut, RedirectToSignIn)
- Responsive UI with Tailwind CSS and shadcn/ui design system
- Database schema for user, session, account, and verification tables
- Comprehensive documentation
- Development and testing setup

### Features
- Secure session management
- Protected routes
- Remote PostgreSQL database connection
- Professional sign-in page
- User profile display on dashboard
- Navigation bar with auth state

### Infrastructure
- Remote PostgreSQL database (46.4.101.229:7772)
- Better Auth CLI integration
- Database migration scripts
- Health check scripts
- Automated testing with Chrome DevTools

---

## Future Plans

### Planned Features
- [ ] Complete Microsoft OAuth setup and testing
- [ ] Add email/password authentication UI
- [ ] Implement password reset flow
- [ ] Add 2FA support
- [ ] User profile editing
- [ ] Session management UI
- [ ] Admin dashboard

### Potential OAuth Providers
- [ ] Google OAuth
- [ ] GitHub OAuth
- [ ] Apple Sign-In

---

**Note:** Some documentation files (README.md, QUICK_START.md, etc.) may still reference Discord. These are legacy references and Discord authentication is no longer supported.
