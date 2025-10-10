# MemOctopus Frontend

A Next.js application with Better Auth integration supporting Microsoft and Discord OAuth authentication.

## Features

- 🔐 **Better Auth** - Modern authentication system
- 🎨 **Tailwind CSS** - Utility-first CSS framework
- 🧩 **shadcn/ui** - Beautiful UI components via better-auth-ui
- 🔑 **Microsoft OAuth** - Sign in with Microsoft accounts
- 💬 **Discord OAuth** - Sign in with Discord accounts
- ⚡ **Next.js 15** - Latest Next.js with App Router
- 📘 **TypeScript** - Type-safe development

## Prerequisites

Before you begin, ensure you have:

- Node.js 18+ installed
- PostgreSQL database (or another supported database)
- Microsoft Azure OAuth application
- Discord OAuth application

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up OAuth Applications

#### Microsoft OAuth Setup

1. Go to [Azure Portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Click "New registration"
3. Name your application (e.g., "MemOctopus")
4. Set redirect URI: `http://localhost:3000/api/auth/callback/microsoft`
5. Copy the **Application (client) ID**
6. Go to "Certificates & secrets" → "New client secret"
7. Copy the **Client secret value**

#### Discord OAuth Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Name your application (e.g., "MemOctopus")
4. Go to "OAuth2" → "General"
5. Add redirect URL: `http://localhost:3000/api/auth/callback/discord`
6. Copy the **Client ID** and **Client Secret**

### 3. Configure Environment Variables

Copy `.env.example` to `.env.local` and fill in your credentials:

```bash
cp .env.example .env.local
```

Then edit `.env.local`:

```env
# Database - Replace with your PostgreSQL connection string
DATABASE_URL="postgresql://user:password@localhost:5432/memoctopus"

# Better Auth - Generate a secret key
BETTER_AUTH_SECRET="your-secret-key-here"
BETTER_AUTH_URL="http://localhost:3000"

# Microsoft OAuth - From Azure Portal
MICROSOFT_CLIENT_ID="your-microsoft-client-id"
MICROSOFT_CLIENT_SECRET="your-microsoft-client-secret"

# Discord OAuth - From Discord Developer Portal
DISCORD_CLIENT_ID="your-discord-client-id"
DISCORD_CLIENT_SECRET="your-discord-client-secret"
```

Generate a secure secret key:
```bash
openssl rand -base64 32
```

### 4. Set Up Database

Initialize your PostgreSQL database with Better Auth tables:

```bash
# Quick setup (creates DB + runs migrations)
npm run db:init

# Or step-by-step:
npm run db:setup      # Create database
npm run db:generate   # Generate schema
npm run db:migrate    # Create tables
```

Verify setup:
```bash
npm run db:check
```

**Detailed Guide:** See [DATABASE_SETUP.md](./DATABASE_SETUP.md)

### 5. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see your application.

## Project Structure

```
frontend/
├── app/
│   ├── api/auth/[...all]/   # Better Auth API routes
│   ├── auth/sign-in/        # Sign-in page
│   ├── dashboard/           # Protected dashboard
│   ├── layout.tsx           # Root layout
│   ├── page.tsx             # Home page
│   └── globals.css          # Global styles
├── components/
│   └── providers.tsx        # Auth UI Provider
├── lib/
│   ├── auth.ts              # Better Auth server config
│   ├── auth-client.ts       # Better Auth client
│   └── utils.ts             # Utility functions
├── .env.local               # Environment variables
└── package.json
```

## Authentication Flow

1. User visits `/auth/sign-in`
2. Clicks "Continue with Microsoft" or "Continue with Discord"
3. Redirects to OAuth provider for authentication
4. Provider redirects back to `/api/auth/callback/{provider}`
5. Better Auth creates session and redirects to `/dashboard`
6. Protected pages use `<RedirectToSignIn />` and `<SignedIn>` components

## Available Scripts

### Development
- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint

### Database
- `npm run db:init` - Complete database initialization (setup + generate + migrate)
- `npm run db:check` - Check database connection and show tables
- `npm run db:setup` - Create database if it doesn't exist
- `npm run db:generate` - Generate schema from Better Auth config
- `npm run db:migrate` - Run database migrations

## Key Components

### Sign-In Page (`app/auth/sign-in/page.tsx`)

Custom login page with Microsoft and Discord buttons.

### Dashboard (`app/dashboard/page.tsx`)

Protected page that shows user information after login.

### Providers (`components/providers.tsx`)

Wraps the app with AuthUIProvider for better-auth-ui components.

## Configuration

### Microsoft OAuth

The Microsoft provider is configured with:
- `tenantId: "common"` - Allows any Microsoft account
- `prompt: "select_account"` - Shows account selector

You can customize these in `lib/auth.ts`.

### Discord OAuth

Discord provider uses default scopes (`identify`, `email`).

## Troubleshooting

### Database Connection Issues

Ensure your PostgreSQL database is running and the `DATABASE_URL` is correct.

### OAuth Redirect Issues

Make sure your redirect URIs in the OAuth applications match:
- Microsoft: `http://localhost:3000/api/auth/callback/microsoft`
- Discord: `http://localhost:3000/api/auth/callback/discord`

### Build Errors

If you encounter build errors, try:
```bash
rm -rf .next node_modules
npm install
npm run dev
```

## Production Deployment

1. Update environment variables for production
2. Update OAuth redirect URIs to your production domain
3. Set `BETTER_AUTH_URL` to your production URL
4. Deploy to your hosting platform (Vercel, etc.)

## Learn More

- [Better Auth Documentation](https://www.better-auth.com)
- [Better Auth UI Documentation](https://better-auth-ui.com)
- [Next.js Documentation](https://nextjs.org/docs)
- [Tailwind CSS](https://tailwindcss.com)

## License

This project is part of the MemOctopus application.
