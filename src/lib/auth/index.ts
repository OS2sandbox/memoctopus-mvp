export const DEMO_USER = {
  id: 'demo',
  name: 'Demo',
  email: 'demo@example.com',
};

export const auth = {
  api: {
    getSession: async (_opts?: unknown) => ({ user: DEMO_USER }),
  },
};

export type Auth = typeof auth;
