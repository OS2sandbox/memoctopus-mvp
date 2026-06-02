FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Install Playwright browsers (Chromium + MS Edge)
RUN npx playwright install chromium msedge

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
