# Hosted live dashboard: watches the agent wallets on-chain and serves the page.
# Needs SVS_X_TOKEN and SOLANA_RPC_URL; uses only public addresses (deploy/agents.json).
FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY data ./data
COPY deploy ./deploy
ENV NODE_ENV=production NO_COLOR=1
EXPOSE 8080
CMD ["pnpm", "exec", "tsx", "src/main.ts", "--config", "deploy/swarm.json", "--watch", "--agents", "--dashboard"]
