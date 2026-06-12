export const DEMO_USER = {
  id: 'demo-user',
  email: 'demo@referat.local',
  name: 'Demo Bruger',
  createdAt: new Date('2024-01-01'),
};

export const auth = {
  api: {
    async getSession(_opts?: unknown) {
      return { user: DEMO_USER, session: { id: 'demo-session' } };
    },
  },
  handler: async (_req: Request) => new Response(null, { status: 204 }),
};

export type Auth = typeof auth;
